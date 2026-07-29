declare const Zotero: {
  ZoteroAIGuidedReader?: {
    data?: {
      initialized?: boolean;
    };
  };
};

declare const chai: {
  assert: {
    isTrue(value: unknown, message?: string): void;
  };
};

declare function describe(title: string, run: () => void): void;
declare function it(title: string, run: () => void): void;

describe("Zotero AI Guided Reader", () => {
  it("loads and completes initialization", () => {
    chai.assert.isTrue(
      Zotero.ZoteroAIGuidedReader?.data?.initialized,
      "The plugin should expose an initialized runtime instance.",
    );
  });
});
