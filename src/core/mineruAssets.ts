export interface MinerUAssetDescriptor {
  zipPath: string;
  aliases: string[];
  storedName: string;
}

const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function describeMinerUAsset(
  value: string,
): MinerUAssetDescriptor | undefined {
  const zipPath = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = zipPath.split("/").filter(Boolean);
  if (
    !zipPath ||
    zipPath.startsWith("/") ||
    /^[A-Za-z]:/.test(zipPath) ||
    segments.includes("..")
  ) {
    return undefined;
  }

  const imagesIndex = segments.findIndex(
    (segment) => segment.toLocaleLowerCase() === "images",
  );
  if (imagesIndex < 0 || imagesIndex === segments.length - 1) return undefined;
  const imagePath = segments.slice(imagesIndex).join("/");
  const basename = segments.at(-1) || "";
  const extension = basename
    .slice(basename.lastIndexOf("."))
    .toLocaleLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) return undefined;

  const storedName = imagePath
    .replace(/\//g, "__")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(-160);
  if (!storedName || storedName.startsWith(".")) return undefined;

  return {
    zipPath,
    aliases: [...new Set([zipPath, imagePath, basename])],
    storedName,
  };
}
