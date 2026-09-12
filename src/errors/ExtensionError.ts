export class ExtensionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ExtensionError'
  }
}

export class ExtensionLoadError extends ExtensionError {
  constructor(message: string, cause?: unknown) {
    super(message, 'EXTENSION_LOAD_ERROR', cause)
    this.name = 'ExtensionLoadError'
  }
}

export class ExtensionActivationError extends ExtensionError {
  constructor(message: string, cause?: unknown) {
    super(message, 'EXTENSION_ACTIVATION_ERROR', cause)
    this.name = 'ExtensionActivationError'
  }
}

export class ExtensionInvokeError extends ExtensionError {
  constructor(message: string, cause?: unknown) {
    super(message, 'EXTENSION_INVOKE_ERROR', cause)
    this.name = 'ExtensionInvokeError'
  }
}

export class ExtensionTimeoutError extends ExtensionError {
  constructor(message: string, cause?: unknown) {
    super(message, 'EXTENSION_TIMEOUT', cause)
    this.name = 'ExtensionTimeoutError'
  }
}

export class ExtensionProcessError extends ExtensionError {
  constructor(message: string, cause?: unknown) {
    super(message, 'EXTENSION_PROCESS_ERROR', cause)
    this.name = 'ExtensionProcessError'
  }
}
