import assert from "node:assert/strict";
import test from "node:test";
import {
  getLibraryMenuState,
  type PdfInspectableItem,
} from "../src/core/librarySelection";

function makeItem(options: {
  id: number;
  pdf?: boolean;
  regular?: boolean;
  attachments?: number[];
}): PdfInspectableItem {
  return {
    id: options.id,
    isPDFAttachment: () => options.pdf === true,
    isRegularItem: () => options.regular === true,
    getAttachments: () => options.attachments || [],
  };
}

test("enables AI guided reading for one selected PDF", () => {
  const pdf = makeItem({ id: 1, pdf: true });
  assert.deepEqual(getLibraryMenuState([pdf], () => undefined), {
    visible: true,
    enabled: true,
    item: pdf,
  });
});

test("enables a regular item when one child attachment is a PDF", () => {
  const paper = makeItem({ id: 1, regular: true, attachments: [2, 3] });
  const children = new Map([
    [2, makeItem({ id: 2 })],
    [3, makeItem({ id: 3, pdf: true })],
  ]);
  assert.deepEqual(getLibraryMenuState([paper], (id) => children.get(id)), {
    visible: true,
    enabled: true,
    item: paper,
  });
});

test("keeps the menu visible but disabled for a paper without a PDF", () => {
  const paper = makeItem({ id: 1, regular: true, attachments: [2] });
  assert.deepEqual(
    getLibraryMenuState([paper], () => makeItem({ id: 2 })),
    { visible: true, enabled: false, item: paper },
  );
});

test("hides the menu for multiple selection or unsupported item types", () => {
  const paper = makeItem({ id: 1, regular: true });
  const second = makeItem({ id: 2, regular: true });
  assert.deepEqual(getLibraryMenuState([paper, second], () => undefined), {
    visible: false,
    enabled: false,
  });
  assert.deepEqual(
    getLibraryMenuState([makeItem({ id: 3 })], () => undefined),
    { visible: false, enabled: false },
  );
});
