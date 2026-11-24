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
  const repostFeedToStories = Boolean(
    post.destinations?.repostFeedToStories ?? post.repostFeedToStories ?? false
  );
  const feed = Boolean(post.destinations?.feed ?? post.postToFeed ?? false);
  const reels = Boolean(post.destinations?.reels ?? post.postToReels ?? false);
  const directStories = Boolean(post.destinations?.stories ?? post.postToStories ?? false);
  const publishToStories = directStories || repostFeedToStories;

  return {
    feed,
    reels,
    stories: directStories,
    repostFeedToStories,
    publishToStories
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
  const baseTemplate = path.join(
    tempDir,
    `ytdlp_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
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

function extractFbSettings(post) {
  const s = post.fbSettings && typeof post.fbSettings === "object" ? post.fbSettings : {};

  const locationData = post.locationData || s.locationData || null;
  const location = (post.location || s.location || locationData?.name || "").trim();

  const rawTaggedPages = Array.isArray(post.taggedPages)
    ? post.taggedPages
    : Array.isArray(s.taggedPages)
      ? s.taggedPages
      : [];

  const rawTaggedPeople = Array.isArray(post.taggedPeople)
    ? post.taggedPeople
    : Array.isArray(s.taggedPeople)
      ? s.taggedPeople
      : rawTaggedPages.map((p) => p?.fbPageId).filter(Boolean);

  const taggedIds = Array.from(
    new Set(
      [...rawTaggedPeople, ...rawTaggedPages.map((p) => p?.fbPageId)]
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )
  );

  const collaboratorPage = post.collaboratorPage || s.collaboratorPage || null;
  const collaboratorPageId = String(
    post.collaboratorPageId || s.collaboratorPageId || collaboratorPage?.fbPageId || ""
  ).trim();

  const feelingData = post.feelingData || s.feelingData || null;
  const feelingCode = String(post.feelingCode || s.feelingCode || feelingData?.code || "").trim();
  const feelingActivity = String(
    post.feelingActivity || s.feelingActivity || feelingData?.display || ""
  ).trim();

  const audience = String(
    post.audience || s.audience || post.privacy?.value || s.privacy?.value || "EVERYONE"
  ).trim();
  const whoCanComment = String(post.whoCanComment || s.whoCanComment || "PUBLIC").trim();
  const playlist = String(post.playlist || s.playlist || "").trim();
  const closedCaptions = Boolean(post.closedCaptions ?? s.closedCaptions ?? true);
  const firstComment = String(post.firstComment || s.firstComment || "").trim();
  const isAiGenerated = Boolean(post.isAiGenerated ?? s.isAiGenerated ?? false);
  const shareToGroups = Boolean(post.shareToGroups ?? s.shareToGroups ?? false);
  const shareToProfile = Boolean(post.shareToProfile ?? s.shareToProfile ?? false);
  const published = Boolean(post.published ?? s.published ?? true);

  return {
    location,
    locationData,
    taggedPages: rawTaggedPages,
    taggedIds,
    collaboratorPage,
    collaboratorPageId,
    feelingCode,
    feelingActivity,
    audience,
    whoCanComment,
    playlist,
    closedCaptions,
    firstComment,
    isAiGenerated,
    shareToGroups,
    shareToProfile,
    published
  };
}

async function resolveFacebookPlaceId({ accessToken, fbSettings }) {
  const { location, locationData } = fbSettings;
  if (!location && !locationData) return null;

  try {
    const queryTerm = (
      locationData?.city ||
      location.split(",")[0] ||
      location
    ).trim();

    const searchParams = new URLSearchParams({
      type: "place",
      fields: "id,name,location",
      limit: "5",
      access_token: accessToken
    });

    if (queryTerm) {
      searchParams.set("q", queryTerm);
    }
    if (
      typeof locationData?.lat === "number" &&
      typeof locationData?.lon === "number"
    ) {
      searchParams.set("center", `${locationData.lat},${locationData.lon}`);
      searchParams.set("distance", "5000");
    }

    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/search?${searchParams.toString()}`
    );
    const data = await res.json();
    if (res.ok && Array.isArray(data.data) && data.data.length > 0) {
      return {
        placeId: String(data.data[0].id),
        placeName: data.data[0].name || location
      };
    }
  } catch (err) {
    console.warn(`Facebook Place lookup skipped (${location}): ${err.message}`);
  }

  return null;
}

/**
 * Keeps the description clean: returns only the post/reel description text
 * without injecting feeling, location, tag, or AI label lines into the text body.
 */
function buildDescriptionOnly(caption) {
  return String(caption || "").trim();
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

async function postFirstComment({ targetObjectId, accessToken, commentText }) {
  if (!targetObjectId || !commentText) return null;

  try {
    const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${targetObjectId}/comments`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        message: commentText,
        access_token: accessToken
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      console.warn(`First comment failed on ${targetObjectId}: ${data.error?.message || res.status}`);
      return null;
    }
    return data.id || true;
  } catch (err) {
    console.warn(`First comment error on ${targetObjectId}: ${err.message}`);
    return null;
  }
}

async function publishFeedToPage({
  fbPageId,
  accessToken,
  caption,
  mediaType,
  linkUrl,
  cachedMedia,
  fbSettings,
  resolvedPlace
}) {
  const validTags = fbSettings.taggedIds.filter((id) => id !== String(fbPageId));
  const descriptionText = buildDescriptionOnly(caption);

  if (mediaType === "link") {
    const targetLink = (linkUrl || extractFirstUrl(caption)).trim();
    if (!targetLink) {
      throw new Error("Link post is missing a valid http(s) URL.");
    }

    const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${fbPageId}/feed`;
    const params = new URLSearchParams({
      link: targetLink,
      published: String(fbSettings.published),
      access_token: accessToken
    });
    if (descriptionText) {
      params.set("message", descriptionText);
    }
    if (resolvedPlace?.placeId) {
      params.set("place", resolvedPlace.placeId);
      if (validTags.length > 0) {
        params.set("tags", validTags.join(","));
      }
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error?.message || `Facebook Feed API error (${response.status})`);
    }
    return data;
  }

  if (mediaType === "text") {
    if (!descriptionText) {
      throw new Error("Text-only post has empty message text.");
    }

    const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${fbPageId}/feed`;
    const body = new URLSearchParams({
      message: descriptionText,
      published: String(fbSettings.published),
      access_token: accessToken
    });
    if (resolvedPlace?.placeId) {
      body.set("place", resolvedPlace.placeId);
      if (validTags.length > 0) {
        body.set("tags", validTags.join(","));
      }
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
  if (descriptionText) {
    formData.append(isVideo ? "description" : "caption", descriptionText);
  }
  formData.append("published", String(fbSettings.published));

  if (resolvedPlace?.placeId) {
    formData.append("place", resolvedPlace.placeId);
  }

  if (!isVideo && validTags.length > 0) {
    formData.append(
      "tags",
      JSON.stringify(validTags.map((id) => ({ tag_uid: id })))
    );
  }

  if (isVideo) {
    if (fbSettings.playlist) {
      formData.append("title", fbSettings.playlist.replace(/_/g, " "));
    }
    if (fbSettings.collaboratorPageId && fbSettings.collaboratorPageId !== String(fbPageId)) {
      formData.append("collaborator_id", fbSettings.collaboratorPageId);
    }
  }

  formData.append("access_token", accessToken);

  let response = await fetch(endpoint, {
    method: "POST",
    body: formData
  });
  let data = await response.json();

  if ((!response.ok || data.error) && isVideo && fbSettings.collaboratorPageId) {
    const retryForm = new FormData();
    retryForm.append("source", blob, filename);
    if (descriptionText) retryForm.append("description", descriptionText);
    retryForm.append("published", String(fbSettings.published));
    if (resolvedPlace?.placeId) retryForm.append("place", resolvedPlace.placeId);
    if (fbSettings.playlist) retryForm.append("title", fbSettings.playlist.replace(/_/g, " "));
    retryForm.append("access_token", accessToken);

    response = await fetch(endpoint, { method: "POST", body: retryForm });
    data = await response.json();
  }

  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Facebook Feed API error (${response.status})`);
  }
  return data;
}

async function publishReelToPage({
  fbPageId,
  accessToken,
  caption,
  cachedMedia,
  fbSettings,
  resolvedPlace
}) {
  const { buffer } = cachedMedia;
  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${fbPageId}/video_reels`;

  const descriptionText = buildDescriptionOnly(caption);

  const startRes = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      upload_phase: "start",
      access_token: accessToken
    })
  });
  const startData = await startRes.json();
  if (!startRes.ok || startData.error || !startData.video_id || !startData.upload_url) {
    throw new Error(startData.error?.message || `Reel upload init failed (${startRes.status})`);
  }

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
    throw new Error(uploadData.error?.message || `Reel binary upload failed (${uploadRes.status})`);
  }

  const buildFinishParams = (includeCollab = true) => {
    const finishParams = new URLSearchParams({
      upload_phase: "finish",
      video_id: startData.video_id,
      video_state: fbSettings.published ? "PUBLISHED" : "DRAFT",
      access_token: accessToken
    });
    if (descriptionText) {
      finishParams.set("description", descriptionText);
    }
    if (fbSettings.playlist) {
      finishParams.set("title", fbSettings.playlist.replace(/_/g, " "));
    }
    if (resolvedPlace?.placeId) {
      finishParams.set("place", resolvedPlace.placeId);
    }
    if (
      includeCollab &&
      fbSettings.collaboratorPageId &&
      fbSettings.collaboratorPageId !== String(fbPageId)
    ) {
      finishParams.set("collaborator_id", fbSettings.collaboratorPageId);
    }
    return finishParams;
  };

  let finishRes = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: buildFinishParams(true)
  });
  let finishData = await finishRes.json();

  if ((!finishRes.ok || finishData.error) && fbSettings.collaboratorPageId) {
    finishRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: buildFinishParams(false)
    });
    finishData = await finishRes.json();
  }

  if (!finishRes.ok || finishData.error) {
    throw new Error(finishData.error?.message || `Facebook Reel publish failed (${finishRes.status})`);
  }

  return {
    ...finishData,
    id: finishData.video_id || startData.video_id
  };
}

async function publishPhotoStoryToPage({ fbPageId, accessToken, cachedMedia }) {
  const { blob, filename } = cachedMedia;

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

  const storyBody = new URLSearchParams({
    photo_id: uploadData.id,
    access_token: accessToken
  });

  const storyRes = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${fbPageId}/photo_stories`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

  const startBody = new URLSearchParams({
    upload_phase: "start",
    access_token: accessToken
  });

  const startRes = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: startBody
  });
  const startData = await startRes.json();
  if (!startRes.ok || startData.error || !startData.video_id || !startData.upload_url) {
    throw new Error(
      startData.error?.message || `Story video upload init failed (${startRes.status})`
    );
  }

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

  const finishBody = new URLSearchParams({
    upload_phase: "finish",
    video_id: startData.video_id,
    access_token: accessToken
  });

  const finishRes = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
  destinations,
  fbSettings
}) {
  const resolvedPlace = await resolveFacebookPlaceId({ accessToken, fbSettings });

  const outcome = {
    feedPostId: null,
    reelPostId: null,
    storyPostId: null,
    firstCommentId: null,
    resolvedPlaceId: resolvedPlace?.placeId || null,
    storyMode: destinations.repostFeedToStories
      ? "repost_feed_to_stories"
      : destinations.stories
        ? "direct_stories"
        : "none",
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
        cachedMedia,
        fbSettings,
        resolvedPlace
      });
      outcome.feedPostId = feedRes.post_id || feedRes.id || null;
    } catch (err) {
      errors.push(`Feed: ${err.message}`);
    }
  }

  if (destinations.reels) {
    if (mediaType !== "video") {
      errors.push("Reels: Facebook Reels require a video.");
    } else {
      try {
        const reelRes = await publishReelToPage({
          fbPageId,
          accessToken,
          caption,
          cachedMedia,
          fbSettings,
          resolvedPlace
        });
        outcome.reelPostId = reelRes.post_id || reelRes.id || null;
      } catch (err) {
        errors.push(`Reels: ${err.message}`);
      }
    }
  }

  const commentTargetId = outcome.feedPostId || outcome.reelPostId;
  if (fbSettings.firstComment && commentTargetId) {
    await sleep(1200);
    outcome.firstCommentId = await postFirstComment({
      targetObjectId: commentTargetId,
      accessToken,
      commentText: fbSettings.firstComment
    });
  }

  if (destinations.publishToStories) {
    const storyLabel = destinations.repostFeedToStories ? "Repost to Stories" : "Stories";
    const supportsStories = mediaType === "image" || mediaType === "video";

    if (!supportsStories) {
      if (!destinations.feed && !destinations.reels) {
        errors.push(`${storyLabel}: Facebook Stories require an image or video.`);
      } else {
        outcome.storySkipped = true;
      }
    } else {
      try {
        if (destinations.feed || destinations.reels) {
          await sleep(1500);
        }
        const storyRes = await publishStoryToPage({
          fbPageId,
          accessToken,
          mediaType,
          cachedMedia
        });
        outcome.storyPostId = storyRes.post_id || storyRes.id || storyRes.video_id || null;
      } catch (err) {
        errors.push(`${storyLabel}: ${err.message}`);
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
    const fbSettings = extractFbSettings(post);

    const targetKeys = Array.isArray(post.targetPages)
      ? post.targetPages
      : Object.values(post.targetPages || {});

    if (!destinations.feed && !destinations.reels && !destinations.publishToStories) {
      const processedAt = Date.now();
      const failedResults = targetKeys.map((pageKey) => ({
        pageKey,
        fbPageId: pages[pageKey]?.fbPageId || null,
        pageName: pages[pageKey]?.pageName || null,
        ok: false,
        error: "No publish destination enabled."
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
            destinations,
            fbSettings
          });
          results.push({
            pageKey,
            fbPageId: page.fbPageId,
            pageName: page.pageName,
            captionUsed: buildDescriptionOnly(pageCaption),
            destinations: {
              feed: destinations.feed,
              reels: destinations.reels,
              stories: destinations.stories,
              repostFeedToStories: destinations.repostFeedToStories
            },
            ok: true,
            postId: fbOutcome.feedPostId || fbOutcome.reelPostId || fbOutcome.storyPostId || null,
            feedPostId: fbOutcome.feedPostId,
            reelPostId: fbOutcome.reelPostId,
            storyPostId: fbOutcome.storyPostId,
            firstCommentId: fbOutcome.firstCommentId,
            resolvedPlaceId: fbOutcome.resolvedPlaceId,
            storyMode: fbOutcome.storyMode,
            storySkipped: fbOutcome.storySkipped
          });
        } catch (err) {
          allSucceeded = false;
          results.push({
            pageKey,
            fbPageId: page.fbPageId,
            pageName: page.pageName,
            captionUsed: buildDescriptionOnly(pageCaption),
            destinations: {
              feed: destinations.feed,
              reels: destinations.reels,
              stories: destinations.stories,
              repostFeedToStories: destinations.repostFeedToStories
            },
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
        caption: buildDescriptionOnly(post.caption || ""),
        linkUrl: linkUrl || "",
        fbSettings: post.fbSettings || fbSettings,
        location: fbSettings.location,
        feelingActivity: fbSettings.feelingActivity,
        collaboratorPageId: fbSettings.collaboratorPageId,
        taggedPages: fbSettings.taggedPages,
        destinations: {
          feed: destinations.feed,
          reels: destinations.reels,
          stories: destinations.stories,
          repostFeedToStories: destinations.repostFeedToStories
        },
        postToFeed: destinations.feed,
        postToReels: destinations.reels,
        postToStories: destinations.stories,
        repostFeedToStories: destinations.repostFeedToStories,
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
