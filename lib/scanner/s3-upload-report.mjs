import { readFile } from "node:fs/promises";
import process from "node:process";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/**
 * Upload HTML report bytes to S3 (optional). Missing env skips upload.
 *
 * Env: PMCI_REPORTS_S3_BUCKET (default pmci-reports), PMCI_REPORTS_S3_REGION,
 * AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (standard SDK chain).
 *
 * @param {{ localPath: string, s3Key: string }} args
 * @returns {Promise<{ skipped?: true, bucket?: string, key?: string, url_hint?: string }>}
 */
export async function uploadReportIfConfigured({ localPath, s3Key }) {
  const bucket = process.env.PMCI_REPORTS_S3_BUCKET?.trim() || "pmci-reports";
  const region = process.env.PMCI_REPORTS_S3_REGION?.trim() || process.env.AWS_REGION?.trim();
  if (!region || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return { skipped: true };
  }
  const body = await readFile(localPath, "utf8");
  const client = new S3Client({ region });
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: body,
      ContentType: "text/html; charset=utf-8",
      CacheControl: "max-age=300",
    }),
  );
  return {
    bucket,
    key: s3Key,
    url_hint: `s3://${bucket}/${s3Key}`,
  };
}
