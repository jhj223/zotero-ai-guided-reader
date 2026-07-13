export interface PdfInspectableItem {
  id: number;
  isPDFAttachment(): boolean;
  isRegularItem(): boolean;
  getAttachments(): number[];
}

export interface LibraryMenuState<T extends PdfInspectableItem> {
  visible: boolean;
  enabled: boolean;
  item?: T;
}

export function getLibraryMenuState<T extends PdfInspectableItem>(
  items: readonly T[] | undefined,
  lookupItem: (id: number) => T | false | undefined,
): LibraryMenuState<T> {
  if (!items || items.length !== 1) {
    return { visible: false, enabled: false };
  }

  const item = items[0];
  if (item.isPDFAttachment()) {
    return { visible: true, enabled: true, item };
  }
  if (!item.isRegularItem()) {
    return { visible: false, enabled: false };
  }

  const enabled = item.getAttachments().some((id) => {
    const attachment = lookupItem(id);
    return attachment ? attachment.isPDFAttachment() : false;
  });
  return { visible: true, enabled, item };
}
