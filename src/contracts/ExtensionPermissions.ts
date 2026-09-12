export interface ExtensionPermissionDescriptor {
  access: string
  allow?: string[]
}

export interface ExtensionPermissionSet {
  filesystem?: ExtensionPermissionDescriptor
  network?: ExtensionPermissionDescriptor
  process?: ExtensionPermissionDescriptor
  device?: ExtensionPermissionDescriptor
  [key: string]: unknown
}
