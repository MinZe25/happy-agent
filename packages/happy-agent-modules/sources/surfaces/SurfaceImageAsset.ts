import { Type, type Static } from "@sinclair/typebox";

export const surfaceImageAssetSchema = Type.Object({
    data: Type.String(),
    thumbhash: Type.String(),
    etag: Type.String(),
});
export type SurfaceImageAsset = Static<typeof surfaceImageAssetSchema>;
