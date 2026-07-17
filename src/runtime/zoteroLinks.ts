export function getOpenPdfLibraryTarget(item: Zotero.Item): {
  libraryType: "library" | "group";
  groupID?: number;
} {
  const library = Zotero.Libraries.get(item.libraryID) as Zotero.Library;
  if (library.libraryType === "group") {
    return {
      libraryType: "group",
      groupID: library.libraryTypeID,
    };
  }
  return { libraryType: "library" };
}
