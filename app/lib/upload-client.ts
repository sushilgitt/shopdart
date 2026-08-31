/**
 * Browser-side driver for a direct-to-Bunny upload.
 *
 * Runs only in the browser: it asks our server for a Bunny slot and signed TUS
 * credentials, then streams the file straight to Bunny. The bytes never pass
 * through Shopdart, and a dropped connection resumes rather than restarting.
 *
 * The credentials are issued by the /api/upload resource route rather than by
 * a page action, because a POST to a page route is a document request and
 * answers with HTML. This needs a JSON body it can read before handing off to
 * tus-js-client.
 *
 * NOTE: app/routes/app.videos.tsx still carries its own copy of this flow.
 * That page's upload path was repaired twice recently and is deliberately left
 * alone here; fold it into this module once TikTok uploads are confirmed
 * working in the real admin.
 */

export interface UploadRequest {
  file: File;
  /** Overrides the filename-derived title. */
  title?: string;
  /** TikTok post link. Recorded as provenance by /api/upload. */
  sourceUrl?: string;
}

export interface UploadHandlers {
  onProgress?: (percent: number) => void;
}

export type UploadOutcome =
  | { ok: true; videoId: string }
  | { ok: false; error: string };

interface CredentialsResponse {
  ok: boolean;
  error?: string;
  videoId?: string;
  upload?: {
    endpoint: string;
    signature: string;
    expire: number;
    videoId: string;
    libraryId: string;
  };
}

export async function startUpload(
  request: UploadRequest,
  handlers: UploadHandlers = {},
): Promise<UploadOutcome> {
  const body = new FormData();
  body.set("fileName", request.file.name);
  if (request.title) body.set("title", request.title);
  if (request.sourceUrl) body.set("sourceUrl", request.sourceUrl);

  let data: CredentialsResponse;
  try {
    const response = await fetch("/api/upload", { method: "POST", body });
    data = (await response.json()) as CredentialsResponse;
  } catch {
    return { ok: false, error: "Couldn't reach Shopdart. Check your connection and try again." };
  }

  if (!data.ok || !data.upload || !data.videoId) {
    return { ok: false, error: data.error ?? "Could not start the upload." };
  }

  const credentials = data.upload;
  const videoId = data.videoId;

  // Browser-only, so it is imported lazily and never lands in the server
  // bundle.
  const tus = await import("tus-js-client");

  return new Promise<UploadOutcome>((resolve) => {
    const upload = new tus.Upload(request.file, {
      endpoint: credentials.endpoint,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      // These must match the values the signature was built from, byte for
      // byte, or Bunny answers 401.
      headers: {
        AuthorizationSignature: credentials.signature,
        AuthorizationExpire: String(credentials.expire),
        VideoId: credentials.videoId,
        LibraryId: credentials.libraryId,
      },
      metadata: {
        filetype: request.file.type || "video/mp4",
        title: request.title || request.file.name,
      },
      onProgress: (sent: number, total: number) => {
        handlers.onProgress?.(Math.round((sent / total) * 100));
      },
      onSuccess: () => resolve({ ok: true, videoId }),
      onError: (error: Error) =>
        resolve({ ok: false, error: error.message || "The upload failed." }),
    });
    upload.start();
  });
}
