import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";

import { pickOriginalFiles } from "@/components/media/image-source";

jest.mock("expo-document-picker", () => ({ getDocumentAsync: jest.fn() }));

jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true })),
  UIImagePickerPreferredAssetRepresentationMode: { Current: "current" },
}));

const getDocumentAsync = DocumentPicker.getDocumentAsync as jest.MockedFunction<
  typeof DocumentPicker.getDocumentAsync
>;
const launchImageLibraryAsync = ImagePicker.launchImageLibraryAsync as jest.MockedFunction<
  typeof ImagePicker.launchImageLibraryAsync
>;

beforeEach(() => jest.clearAllMocks());

describe("picking files to put on a host", () => {
  test("Photos opens in its byte-exact mode, photos and videos, without asking for photo access", async () => {
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///cache/IMG_0001.HEIC",
          fileName: "IMG_0001.HEIC",
          mimeType: "image/heic",
          fileSize: 2048,
          width: 1,
          height: 1,
          type: "image",
        },
        { uri: "file:///cache/clip.mov", width: 1, height: 1, type: "video" },
      ],
    } as Awaited<ReturnType<typeof ImagePicker.launchImageLibraryAsync>>);

    const picked = await pickOriginalFiles("photos");

    expect(launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ["images", "videos"],
      allowsEditing: false,
      allowsMultipleSelection: true,
      selectionLimit: 0,
      quality: 1,
      exif: false,
      preferredAssetRepresentationMode: "current",
    });
    // The photo-access wording is about terminal attachments; the system picker needs none.
    expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(picked).toEqual([
      {
        uri: "file:///cache/IMG_0001.HEIC",
        name: "IMG_0001.HEIC",
        mimeType: "image/heic",
        size: 2048,
      },
      { uri: "file:///cache/clip.mov", name: "video.mov", mimeType: null, size: null },
    ]);
  });

  test("Files takes any file, several at once, copied for reading", async () => {
    getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: "file:///cache/notes.md", name: "notes.md", mimeType: "text/markdown", size: 4 },
      ],
    } as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);

    await expect(pickOriginalFiles("files")).resolves.toEqual([
      { uri: "file:///cache/notes.md", name: "notes.md", mimeType: "text/markdown", size: 4 },
    ]);
    expect(getDocumentAsync).toHaveBeenCalledWith({
      copyToCacheDirectory: true,
      multiple: true,
      type: "*/*",
    });
  });

  test("backing out picks nothing", async () => {
    launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    await expect(pickOriginalFiles("photos")).resolves.toEqual([]);
  });
});
