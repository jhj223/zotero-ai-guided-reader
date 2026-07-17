import type { AnnotationContext } from "../core/types";

export async function resolvePdfAttachment(
  item: Zotero.Item,
): Promise<Zotero.Item> {
  if (item.isAttachment() && item.isPDFAttachment()) {
    return item;
  }

  const best = await item.getBestAttachment();
  if (best && best.isPDFAttachment()) {
    return best;
  }

  for (const attachmentID of item.getAttachments()) {
    const attachment = Zotero.Items.get(attachmentID);
    if (attachment?.isPDFAttachment()) return attachment;
  }

  throw new Error("No PDF attachment found for this item.");
}

export async function getAttachmentFilePath(
  attachment: Zotero.Item,
): Promise<string> {
  const path = await attachment.getFilePathAsync();
  if (!path) {
    throw new Error("The PDF attachment file is missing on disk.");
  }
  return path;
}

export function getAttachmentDisplayName(attachment: Zotero.Item): string {
  return (
    (attachment.getField("title") as string) ||
    (attachment.attachmentFilename as string) ||
    `${attachment.key}.pdf`
  );
}

export function getParentForOutput(attachment: Zotero.Item): Zotero.Item {
  if (attachment.parentID) {
    return Zotero.Items.get(attachment.parentID);
  }
  return attachment;
}

export function readAnnotationContext(
  attachment: Zotero.Item,
): AnnotationContext[] {
  return attachment.getAnnotations(false).map((annotation) => ({
    text: annotation.annotationText || "",
    comment: annotation.annotationComment || undefined,
    pageLabel: annotation.annotationPageLabel || undefined,
    color: annotation.annotationColor || undefined,
  }));
}
