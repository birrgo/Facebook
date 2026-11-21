import admin from "firebase-admin";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
const databaseURL = process.env.FIREBASE_DATABASE_URL;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL
});

const db = admin.database();

function parseBase64DataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) {
    throw new Error("Invalid Base64 image Data URL format.");
  }
  const mimeType = match[1];
  const base64Data = match[2];
  const ext = mimeType.split("/")[1]?.split("+")[0] || "jpg";
  const buffer = Buffer.from(base64Data, "base64");
  return { buffer, mimeType, filename: `upload.${ext}` };
}

async function publishPhotoToPage({ fbPageId, accessToken, caption, imageDataUrl }) {
  const { buffer, mimeType, filename } = parseBase64DataUrl(imageDataUrl);
  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimeType });

  formData.append("source", blob, filename);
  if (caption) {
    formData.append("caption", caption);
  }
  formData.append("access_token", accessToken);

  const response = await fetch(`https://graph.facebook.com/v21.0/${fbPageId}/photos`, {
    method: "POST",
    body: formData
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Facebook API error (${response.status})`);
  }
  return data;
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
        const fbRes = await publishPhotoToPage({
          fbPageId: page.fbPageId,
          accessToken: page.accessToken,
          caption: post.caption || "",
          imageDataUrl: post.imageUrl
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

    await postRef.update({
      status: allSucceeded ? "posted" : "failed",
      processedAt: Date.now(),
      publishResults: results
    });
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
