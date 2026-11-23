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
  const contentType = res.headers.get("content-type") || "";
  const mimeType =
    mediaType === "video"
      ? (contentType.startsWith("video/") ? contentType : "video/mp4")
      : (contentType.startsWith("image/") ? contentType : "image/jpeg");
  const ext = mediaType === "video" ? "mp4" : (mimeType.split("/")[1]?.split("+")[0] || "jpg");

  return {
    blob: new Blob([arrayBuffer], { type: mimeType }),
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

async function publishMediaToPage({
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

    const endpoint = `https://graph.facebook.com/v21.0/${fbPageId}/feed`;
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
      throw new Error(data.error?.message || `Facebook API error (${response.status})`);
    }
    return data;
  }

  if (mediaType === "text") {
    const trimmedMessage = (caption || "").trim();
    if (!trimmedMessage) {
      throw new Error("Text-only post has empty message text.");
    }

    const endpoint = `https://graph.facebook.com/v21.0/${fbPageId}/feed`;
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
      throw new Error(data.error?.message || `Facebook API error (${response.status})`);
    }
    return data;
  }

  const isVideo = mediaType === "video";
  const endpoint = isVideo
    ? `https://graph.facebook.com/v21.0/${fbPageId}/videos`
    : `https://graph.facebook.com/v21.0/${fbPageId}/photos`;

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
    throw new Error(data.error?.message || `Facebook API error (${response.status})`);
  }
  return data;
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

    const targetKeys = Array.isArray(post.targetPages)
      ? post.targetPages
      : Object.values(post.targetPages || {});

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
          const fbRes = await publishMediaToPage({
            fbPageId: page.fbPageId,
            accessToken: page.accessToken,
            caption: pageCaption,
            mediaType,
            linkUrl,
            cachedMedia
          });
          results.push({
            pageKey,
            fbPageId: page.fbPageId,
            pageName: page.pageName,
            captionUsed: pageCaption,
            ok: true,
            postId: fbRes.post_id || fbRes.id || null
          });
        } catch (err) {
          allSucceeded = false;
          results.push({
            pageKey,
            fbPageId: page.fbPageId,
            pageName: page.pageName,
            captionUsed: pageCaption,
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
