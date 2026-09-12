import type { ExtensionInstance } from '../contracts/ExtensionInstance.js'

export class ExtensionRegistry {
  private readonly extensions = new Map<string, ExtensionInstance>()

  register(extension: ExtensionInstance): void {
    if (this.extensions.has(extension.id)) {
      throw new Error(`Extension already registered: ${extension.id}`)
    }

    this.extensions.set(extension.id, extension)
  }

  unregister(extensionId: string): void {
    this.extensions.delete(extensionId)
  }

  get(extensionId: string): ExtensionInstance | undefined {
    return this.extensions.get(extensionId)
  }

  require(extensionId: string): ExtensionInstance {
    const extension = this.get(extensionId)

    if (!extension) {
      throw new Error(`Extension not found: ${extensionId}`)
    }

    return extension
  }

  list(): ExtensionInstance[] {
    return [...this.extensions.values()]
  }

  findByCapability(capability: string): ExtensionInstance[] {
    return this.list().filter((extension) =>
      extension.manifest.capabilities.some((item: { name: string }) => item.name === capability),
    )
  }
}
