export interface RecoveryObject {
  key: string;
  size: number;
  sha256: string;
  md5: string;
}
export interface RecoveryFile extends RecoveryObject {
  path: string;
  mode: number;
  uid: number;
  gid: number;
}
export interface RecoveryDescriptor {
  version: 1;
  checkpointId: string;
  archive: RecoveryObject;
  manifest: RecoveryObject;
  files: RecoveryFile[];
  inventoryDigest: string;
  counts: { entries: number; userFiles: number; databases: number };
}
export interface TransferGrant {
  key: string;
  url: string;
  headers?: Record<string, string>;
}
export function recoveryObjects(value: RecoveryDescriptor): RecoveryObject[] {
  return [
    ...new Map(
      [value.archive, value.manifest, ...value.files].map((item) => [
        item.key,
        item,
      ]),
    ).values(),
  ];
}
