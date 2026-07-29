declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";
declare const __licenseServerUrl__: string;
declare const __licenseIssuer__: string;
declare const __licenseAudience__: string;
declare const __licensePublicKeys__: Readonly<
  Record<string, import("../src/core/licenseConfig").EntitlementPublicJwk>
>;
