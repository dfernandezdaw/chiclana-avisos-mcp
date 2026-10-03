declare module "exif-parser" {
  export interface ExifTags {
    Make?: string;
    Model?: string;
    DateTimeOriginal?: number;
    CreateDate?: number;
    ModifyDate?: number;
    GPSLatitude?: number | [number, number, number];
    GPSLatitudeRef?: string;
    GPSLongitude?: number | [number, number, number];
    GPSLongitudeRef?: string;
    GPSAltitude?: number;
    [key: string]: unknown;
  }

  export interface ExifResult {
    startMarker: number;
    tags: ExifTags;
    imageSize?: {
      width: number;
      height: number;
    };
    hasThumbnail?: () => boolean;
    getThumbnailBuffer?: () => Buffer;
  }

  export interface ExifParser {
    enableSimpleValues(enable: boolean): this;
    enableBinaryFields(enable: boolean): this;
    enablePointers(enable: boolean): this;
    enableTagNames(enable: boolean): this;
    enableImageSizes(enable: boolean): this;
    parse(): ExifResult;
  }

  export function create(buffer: Buffer): ExifParser;
}
