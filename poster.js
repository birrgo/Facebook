import fs from "node:fs";
import os from "node:os"; 
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import admin from "firebase-admin";

const execFileAsync = promisify(execFile);

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
const databaseURL = process.env.FIREBASE_DATABASE_URL;
const storageBucketName =
  process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.firebasestorage.app`;
const PAGE_POST_DELAY_MS = Number(process.env.PAGE_POST_DELAY_MS || 4000);
const GRAPH_API_VERSION = "v21.0";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL,
  storageBucket: storageBucketName
});

const db = admin.database();
const bucket = admin.storage().bucket();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFirstUrl(text = "") {
  const match = String(text).match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].trim() : "";
}

function resolveLinkUrl(post) {
  const explicit = (post.linkUrl || post.shareUrl || post.url || "").trim();
  if (/^https?:\/\//i.test(explicit)) return explicit;
  return extractFirstUrl(post.caption || "");
}

function resolveDestinations(post) {
  const feed = post.destinations?.feed ?? post.postToFeed ?? true;
  const stories = post.destinations?.stories ?? post.postToStories ?? false;
  return {
    feed: Boolean(feed),
    stories: Boolean(stories)
  };
}

function isLinkPost(post, mediaType) {
  return (
    mediaType === "link" ||
    post.postType === "link" ||
    Boolean((post.linkUrl || post.shareUrl || "").trim())
  );
}

function isTextPost(post, mediaType) {
  return (
    !isLinkPost(post, mediaType) &&
    (mediaType === "text" ||
      mediaType === "text_only" ||
      post.postType === "text" ||
      post.postType === "text_only" ||
      post.mimeType === "text/plain")
  );
}

function detectMediaType(post) {
  if (isLinkPost(post, post.mediaType)) {
    return "link";
  }
  if (
    post.mediaType === "text" ||
    post.mediaType === "text_only" ||
    post.postType === "text" ||
    post.postType === "text_only" ||
    post.mimeType === "text/plain"
  ) {
    return "text";
  }
  if (post.mediaType === "video" || post.mimeType?.startsWith("video/")) {
    return "video";
  }
  if (post.mediaType === "image" || post.mimeType?.startsWith("image/")) {
    return "image";
  }
  const hasMedia = Boolean(
    (post.originalVideoUrl || post.videoUrl || post.mediaUrl || post.imageUrl || "").trim()
  );
  return hasMedia ? "image" : "text";
}

function parseBase64DataUrl(dataUrl) {
  const match = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) {
    throw new Error("Invalid Base64 Data URL format.");
  }
  const mimeType = match[1];
  const base64Data = match[2];
  const ext = mimeType.split("/")[1]?.split("+")[0] || "jpg";
  const buffer = Buffer.from(base64Data, "base64");
  return { buffer, mimeType, filename: `upload.${ext}` };
}

function isDirectVideoUrl(url = "") {
  return (
    /\.(mp4|mov|webm|m4v|mkv|ogg)(\?.*)?$/i.test(url) ||
    url.includes("drive.google.com/uc?export=download") ||
    url.includes("dropbox.com")
  );
}

async function downloadVideoWithYtDlp(url, tempDir) {
  const baseTemplate = path.join(tempDir, `ytdlp_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const expectedMp4 = `${baseTemplate}.mp4`;

  await execFileAsync(
    "yt-dlp",
    [
      "--no-playlist",
      "--no-warnings",
      "-f",
      "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
      "--merge-output-format",
      "mp4",
      "-o",
      expectedMp4,
      url
    ],
    { maxBuffer: 25 * 1024 * 1024 }
  );

  if (fs.existsSync(expectedMp4)) {
    return expectedMp4;
  }

  const matchingFile = fs
    .readdirSync(tempDir)
    .map((f) => path.join(tempDir, f))
    .find((fullPath) => fullPath.startsWith(baseTemplate));

  if (!matchingFile) {
    throw new Error(`yt-dlp did not produce a video file for: ${url}`);
  }
  return matchingFile;
}

async function resolveMediaBlob(post, mediaType) {
  if (isTextPost(post, mediaType) || isLinkPost(post, mediaType)) {
    return null;
  }

  const mediaSource = (
    post.originalVideoUrl ||
    post.videoUrl ||
    post.mediaUrl ||
    post.imageUrl ||
    ""
  ).trim();

  if (!mediaSource || typeof mediaSource !== "string") {
    throw new Error("Missing media URL or image data in scheduled post.");
  }

  if (mediaSource.startsWith("data:")) {
    const { buffer, mimeType, filename } = parseBase64DataUrl(mediaSource);
    return {
      blob: new Blob([buffer], { type: mimeType }),
      buffer,
      mimeType,
      filename,
      tempFilePath: null
    };
  }

  if (!/^https?:\/\//i.test(mediaSource)) {
    throw new Error("Unsupported media URL format.");
  }

  const shouldUseYtDlp =
    mediaType === "video" && (Boolean(post.requiresExtractor) || !isDirectVideoUrl(mediaSource));

  if (shouldUseYtDlp) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb_video_"));
    try {
      const downloadedPath = await downloadVideoWithYtDlp(mediaSource, tempDir);
      const fileBuffer = fs.readFileSync(downloadedPath);
      return {
        blob: new Blob([fileBuffer], { type: "video/mp4" }),
        buffer: fileBuffer,
        mimeType: "video/mp4",
        filename: path.basename(downloadedPath) || "video.mp4",
        tempFilePath: tempDir
      };
    } catch (err) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw new Error(`Failed to extract video from link (${mediaSource}): ${err.message}`);
    }
  }

  const res = await fetch(mediaSource);
  if (!res.ok) {
    throw new Error(`Failed to download media (${res.status}) from ${mediaSource}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = res.headers.get("content-type") || "";
  const mimeType =
    mediaType === "video"
      ? (contentType.startsWith("video/") ? contentType : "video/mp4")
      : (contentType.startsWith("image/") ? contentType : "image/jpeg");
  const ext = mediaType === "video" ? "mp4" : (mimeType.split("/")[1]?.split("+")[0] || "jpg");

  return {
    blob: new Blob([buffer], { type: mimeType }),
    buffer,
    mimeType,
    filename: post.fileName || `upload.${ext}`,
    tempFilePath: null
  };
}

function cleanupTempMedia(cachedMedia) {
  if (cachedMedia?.tempFilePath) {
    try {
      fs.rmSync(cachedMedia.tempFilePath, { recursive: true, force: true });
    } catch {}
  }
}

function resolveCaptionForPage(post, pageKey, page) {
  const variations = post.pageVariations;
  if (post.valueAddEnabled && variations && typeof variations === "object") {
    const byKey = variations[pageKey];
    if (byKey && typeof byKey.finalCaption === "string" && byKey.finalCaption.trim()) {
      return byKey.finalCaption.trim();
    }

    if (page?.fbPageId) {
      const byFbId = Object.values(variations).find(
        (v) =>
          v &&
          String(v.fbPageId) === String(page.fbPageId) &&
          typeof v.finalCaption === "string" &&
          v.finalCaption.trim()
      );
      if (byFbId) {
        return byFbId.finalCaption.trim();
      }
    }
  }

  return (post.caption || "").trim();
}

async function publishFeedToPage({
  fbPageId,
  accessToken,
  caption,
  mediaType,
  linkUrl,
  cachedMedia
}) {
  if (mediaType === "link") {
    const targetLink = (linkUrl || extractFirstUrl(caption)).trim();
    if (!targetLink) {
      throw new Error("Link post is missing a valid http(s) URL.");
    }

    const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${fbPageId}/feed`;
    const params = new URLSearchParams({
      link: targetLink,
      access_token: accessToken
    });
    if ((caption || "").trim()) {
      params.set("message", caption.trim());
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error?.message || `Facebook Feed API error (${response.status})`);
    }
    return data;
  }

  if (mediaType === "text") {
    const trimmedMessage = (caption || "").trim();
    if (!trimmedMessage) {
      throw new Error("Text-only post has empty message text.");
    }

    const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${fbPageId}/feed`;
    const body = new URLSearchParams({
      message: trimmedMessage,
      access_token: accessToken
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error?.message || `Facebook Feed API error (${response.status})`);
    }
    return data;
  }

  const isVideo = mediaType === "video";
  const endpoint = isVideo
    ? `https://graph.facebook.com/${GRAPH_API_VERSION}/${fbPageId}/videos`
    : `https://graph.facebook.com/${GRAPH_API_VERSION}/${fbPageId}/photos`;

  const { blob, filename } = cachedMedia;
  const formData = new FormData();

  formData.append("source", blob, filename);
  if (caption) {
    formData.append(isVideo ? "description" : "caption", caption);
  }
  formData.append("access_token", accessToken);

  const response = await fetch(endpoint, {
    method: "POST",
    body: formData
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Facebook Feed API error (${response.status})`);
  }
  return data;
}

async function publishPhotoStoryToPage({ fbPageId, accessToken, cachedMedia }) {
  const { blob, filename } = cachedMedia;

  // Step 1: Upload photo as unpublished (published=false) so it can be attached to a Story
  const uploadForm = new FormData();
  uploadForm.append("source", blob, filename);
  uploadForm.append("published", "false");
  uploadForm.append("access_token", accessToken);

  const uploadRes = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${fbPageId}/photos`,
    {
      method: "POST",
      body: uploadForm
    }
  );
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok || uploadData.error || !uploadData.id) {
    throw new Error(
      uploadData.error?.message || `Story photo upload failed (${uploadRes.status})`
    );
  }

  // Step 2: Publish the unpublished photo_id as a Page Story
  const storyBody = new URLSearchParams({
    photo_id: uploadData.id,
    access_token: accessToken
  });

  const storyRes = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${fbPageId}/photo_stories`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: storyBody
    }
  );
  const storyData = await storyRes.json();
  if (!storyRes.ok || storyData.error) {
    throw new Error(
      storyData.error?.message || `Facebook Photo Story API error (${storyRes.status})`
    );
  }
  return storyData;
}

async function publishVideoStoryToPage({ fbPageId, accessToken, cachedMedia }) {
  const { buffer } = cachedMedia;
  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${fbPageId}/video_stories`;

  // Step 1: Initialize resumable Story video upload
  const startBody = new URLSearchParams({
    upload_phase: "start",
    access_token: accessToken
  });

  const startRes = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: startBody
  });
  const startData = await startRes.json();
  if (!startRes.ok || startData.error || !startData.video_id || !startData.upload_url) {
    throw new Error(
      startData.error?.message || `Story video upload init failed (${startRes.status})`
    );
  }

  // Step 2: Upload video binary to Meta's rupload URL
  const uploadRes = await fetch(startData.upload_url, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessToken}`,
      offset: "0",
      file_size: String(buffer.byteLength),
      "Content-Type": "application/octet-stream"
    },
    body: buffer
  });
  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || uploadData.error) {
    throw new Error(
      uploadData.error?.message || `Story video binary upload failed (${uploadRes.status})`
    );
  }

  // Step 3: Finish and publish the Video Story
  const finishBody = new URLSearchParams({
    upload_phase: "finish",
    video_id: startData.video_id,
    access_token: accessToken
  });

  const finishRes = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: finishBody
  });
  const finishData = await finishRes.json();
  if (!finishRes.ok || finishData.error) {
    throw new Error(
      finishData.error?.message || `Facebook Video Story finish failed (${finishRes.status})`
    );
  }
  return {
    ...finishData,
    video_id: finishData.video_id || startData.video_id
  };
}

async function publishStoryToPage({ fbPageId, accessToken, mediaType, cachedMedia }) {
  if (mediaType === "image") {
    return publishPhotoStoryToPage({ fbPageId, accessToken, cachedMedia });
  }
  if (mediaType === "video") {
    return publishVideoStoryToPage({ fbPageId, accessToken, cachedMedia });
  }
  throw new Error("Facebook Stories require an image or video (text/link-only is unsupported).");
}

async function publishToPageTargets({
  fbPageId,
  accessToken,
  caption,
  mediaType,
  linkUrl,
  cachedMedia,
  destinations
}) {
  const outcome = {
    feedPostId: null,
    storyPostId: null,
    storySkipped: false
  };
  const errors = [];

  if (destinations.feed) {
    try {
      const feedRes = await publishFeedToPage({
        fbPageId,
        accessToken,
        caption,
        mediaType,
        linkUrl,
        cachedMedia
      });
      outcome.feedPostId = feedRes.post_id || feedRes.id || null;
    } catch (err) {
      errors.push(`Feed: ${err.message}`);
    }
  }

  if (destinations.stories) {
    const supportsStories = mediaType === "image" || mediaType === "video";
    if (!supportsStories) {
      if (!destinations.feed) {
        errors.push("Stories: Facebook Stories require an image or video.");
      } else {
        outcome.storySkipped = true;
      }
    } else {
      try {
        if (destinations.feed) {
          await sleep(1000);
        }
        const storyRes = await publishStoryToPage({
          fbPageId,
          accessToken,
          mediaType,
          cachedMedia
        });
        outcome.storyPostId = storyRes.post_id || storyRes.id || storyRes.video_id || null;
      } catch (err) {
        errors.push(`Stories: ${err.message}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }

  return outcome;
}

async function deleteStorageFileIfPresent(storagePath) {
  if (!storagePath || typeof storagePath !== "string") return;
  try {
    await bucket.file(storagePath).delete({ ignoreNotFound: true });
    console.log(`Deleted Firebase Storage file: ${storagePath}`);
  } catch (err) {
    console.warn(`Failed to delete Storage file ${storagePath}:`, err.message);
  }
}

async function run() {
  const now = Date.now();
  const [postsSnap, pagesSnap] = await Promise.all([
    db.ref("scheduledPosts").orderByChild("status").equalTo("pending").once("value"),
    db.ref("fbPages").once("value")
  ]);

  const pendingPosts = postsSnap.val() || {};
  const pages = pagesSnap.val() || {};

  const postEntries = Object.entries(pendingPosts).filter(
    ([, post]) => typeof post.scheduledTime === "number" && post.scheduledTime <= now
  );

  if (postEntries.length === 0) {
    console.log("No due pending posts found.");
    return;
  }

  for (const [postId, post] of postEntries) {
    const postRef = db.ref(`scheduledPosts/${postId}`);
    await postRef.update({ status: "processing", startedAt: Date.now() });

    const mediaType = detectMediaType(post);
    const linkUrl = mediaType === "link" ? resolveLinkUrl(post) : "";
    const destinations = resolveDestinations(post);

    const targetKeys = Array.isArray(post.targetPages)
      ? post.targetPages
      : Object.values(post.targetPages || {});

    if (!destinations.feed && !destinations.stories) {
      const processedAt = Date.now();
      const failedResults = targetKeys.map((pageKey) => ({
        pageKey,
        fbPageId: pages[pageKey]?.fbPageId || null,
        pageName: pages[pageKey]?.pageName || null,
        ok: false,
        error: "No publish destination enabled (both Feed and Stories are false)."
      }));

      await postRef.update({
        status: "failed",
        processedAt,
        publishResults: failedResults
      });
      continue;
    }

    let cachedMedia = null;
    try {
      cachedMedia = await resolveMediaBlob(post, mediaType);
    } catch (mediaErr) {
      const processedAt = Date.now();
      const failedResults = targetKeys.map((pageKey) => ({
        pageKey,
        fbPageId: pages[pageKey]?.fbPageId || null,
        pageName: pages[pageKey]?.pageName || null,
        ok: false,
        error: mediaErr.message
      }));

      await postRef.update({
        status: "failed",
        processedAt,
        publishResults: failedResults
      });
      continue;
    }

    const results = [];
    let allSucceeded = true;

    try {
      for (let i = 0; i < targetKeys.length; i++) {
        const pageKey = targetKeys[i];
        if (i > 0 && PAGE_POST_DELAY_MS > 0) {
          await sleep(PAGE_POST_DELAY_MS);
        }

        const page = pages[pageKey];
        if (!page) {
          allSucceeded = false;
          results.push({ pageKey, ok: false, error: "Page not found in fbPages" });
          continue;
        }

        const pageCaption = resolveCaptionForPage(post, pageKey, page);

        try {
          const fbOutcome = await publishToPageTargets({
            fbPageId: page.fbPageId,
            accessToken: page.accessToken,
            caption: pageCaption,
            mediaType,
            linkUrl,
            cachedMedia,
            destinations
          });
          results.push({
            pageKey,
            fbPageId: page.fbPageId,
            pageName: page.pageName,
            captionUsed: pageCaption,
            destinations,
            ok: true,
            postId: fbOutcome.feedPostId || fbOutcome.storyPostId || null,
            feedPostId: fbOutcome.feedPostId,
            storyPostId: fbOutcome.storyPostId,
            storySkipped: fbOutcome.storySkipped
          });
        } catch (err) {
          allSucceeded = false;
          results.push({
            pageKey,
            fbPageId: page.fbPageId,
            pageName: page.pageName,
            captionUsed: pageCaption,
            destinations,
            ok: false,
            error: err.message
          });
        }
      }
    } finally {
      cleanupTempMedia(cachedMedia);
    }

    const processedAt = Date.now();

    await postRef.update({
      status: allSucceeded ? "posted" : "failed",
      processedAt,
      publishResults: results
    });

    if (allSucceeded) {
      await deleteStorageFileIfPresent(post.storagePath);
      await db.ref("postedHistory").push({
        sourcePostId: postId,
        caption: post.caption || "",
        linkUrl: linkUrl || "",
        destinations,
        postToFeed: destinations.feed,
        postToStories: destinations.stories,
        valueAddEnabled: Boolean(post.valueAddEnabled),
        mediaType,
        fileName: post.fileName || "",
        targetPages: targetKeys,
        postedAt: processedAt,
        publishResults: results
      });
    }
  }
}

run()
  .then(() => {
    console.log("Worker run complete.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Worker fatal error:", err);
    process.exit(1);
  });
