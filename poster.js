import admin from "firebase-admin";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
const databaseURL = process.env.FIREBASE_DATABASE_URL;
const storageBucketName =
  process.env.FIREBASE_STORAGE_BUCKET || serviceAccount.project_id + ".firebasestorage.app";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL,
  storageBucket: storageBucketName
});

const db = admin.database();
const bucket = admin.storage().bucket();

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

async function resolveMediaBlob(mediaSource) {
  if (!mediaSource || typeof mediaSource !== "string") {
    throw new Error("Missing media URL or image data in scheduled post.");
  }

  if (mediaSource.startsWith("data:")) {
    const { buffer, mimeType, filename } = parseBase64DataUrl(mediaSource);
    return {
      blob: new Blob([buffer], { type: mimeType }),
      filename,
      remoteUrl: null
    };
  }

  if (/^https?:\/\//i.test(mediaSource)) {
    const res = await fetch(mediaSource);
    if (!res.ok) {
      throw new Error(`Failed to download media (${res.status}) from ${mediaSource}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    const mimeType = res.headers.get("content-type") || "image/jpeg";
    const ext = mimeType.includes("video") ? "mp4" : "jpg";
    return {
      blob: new Blob([arrayBuffer], { type: mimeType }),
      filename: `upload.${ext}`,
      remoteUrl: mediaSource
    };
  }

  throw new Error("Unsupported media URL format.");
}

async function publishMediaToPage({ fbPageId, accessToken, caption, mediaSource, mediaType }) {
  const isVideo = mediaType === "video";
  const endpoint = isVideo
    ? `https://graph.facebook.com/v21.0/${fbPageId}/videos`
    : `https://graph.facebook.com/v21.0/${fbPageId}/photos`;

  const { blob, filename, remoteUrl } = await resolveMediaBlob(mediaSource);
  const formData = new FormData();

  if (isVideo && remoteUrl) {
    formData.append("file_url", remoteUrl);
    if (caption) formData.append("description", caption);
  } else {
    formData.append("source", blob, filename);
    if (caption) {
      formData.append(isVideo ? "description" : "caption", caption);
    }
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

    const mediaSource = post.mediaUrl || post.imageUrl;
    const mediaType =
      post.mediaType || (post.mimeType?.startsWith("video/") ? "video" : "image");

    const targetKeys = Array.isArray(post.targetPages)
      ? post.targetPages
      : Object.values(post.targetPages || {});

    const results = [];
    let allSucceeded = true;

    for (const pageKey of targetKeys) {
      const page = pages[pageKey];
      if (!page) {
        allSucceeded = false;
        results.push({ pageKey, ok: false, error: "Page not found in fbPages" });
        continue;
      }

      try {
        const fbRes = await publishMediaToPage({
          fbPageId: page.fbPageId,
          accessToken: page.accessToken,
          caption: post.caption || "",
          mediaSource,
          mediaType
        });
        results.push({
          pageKey,
          fbPageId: page.fbPageId,
          pageName: page.pageName,
          ok: true,
          postId: fbRes.post_id || fbRes.id || null
        });
      } catch (err) {
        allSucceeded = false;
        results.push({
          pageKey,
          fbPageId: page.fbPageId,
          pageName: page.pageName,
          ok: false,
          error: err.message
        });
      }
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
