import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";

import { pickImage, pickImages } from "@/components/media/image-source";

jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn(),
}));

jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true })),
}));

const getDocumentAsync = DocumentPicker.getDocumentAsync as jest.MockedFunction<
  typeof DocumentPicker.getDocumentAsync
>;
const launchImageLibraryAsync = ImagePicker.launchImageLibraryAsync as jest.MockedFunction<
  typeof ImagePicker.launchImageLibraryAsync
>;

function libraryResult(assets: { uri: string; fileName?: string }[]): unknown {
  return { canceled: false, assets: assets.map((asset) => ({ mimeType: "image/jpeg", ...asset })) };
}

describe("picking images for an input that takes several", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("the photo library is opened without a selection limit", async () => {
    launchImageLibraryAsync.mockResolvedValue(
      libraryResult([
        { uri: "file:///one.jpg", fileName: "one.jpg" },
        { uri: "file:///two.jpg", fileName: "two.jpg" },
      ]) as Awaited<ReturnType<typeof ImagePicker.launchImageLibraryAsync>>,
    );

    const picked = await pickImages("photos", { multiple: true });

    expect(launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ selectionLimit: 0 }),
    );
    expect(picked.map((image) => image.name)).toEqual(["one.jpg", "two.jpg"]);
  });

  test("the document picker is told it may return more than one file", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: "file:///notes.txt", name: "notes.txt", mimeType: "text/plain", size: 4 },
        { uri: "file:///run.log", name: "run.log", mimeType: null, size: 8 },
      ],
    } as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);

    const picked = await pickImages("files", { fileTypes: "*/*", multiple: true });

    expect(getDocumentAsync).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true, type: "*/*" }),
    );
    expect(picked).toEqual([
      { uri: "file:///notes.txt", name: "notes.txt", mimeType: "text/plain" },
      { uri: "file:///run.log", name: "run.log", mimeType: null },
    ]);
  });

  test("backing out of the picker yields nothing rather than a null entry", async () => {
    launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });

    expect(await pickImages("photos", { multiple: true })).toEqual([]);
  });
});

describe("picking one image for an input that holds one", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("the limit stays at one even when the caller asked for many", async () => {
    launchImageLibraryAsync.mockResolvedValue(
      libraryResult([{ uri: "file:///icon.png", fileName: "icon.png" }]) as Awaited<
        ReturnType<typeof ImagePicker.launchImageLibraryAsync>
      >,
    );

    const picked = await pickImage("photos", { multiple: true });

    expect(launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ selectionLimit: 1 }),
    );
    expect(picked?.name).toBe("icon.png");
  });

  test("a cancelled pick is null", async () => {
    launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });

    expect(await pickImage("photos")).toBeNull();
  });
});
