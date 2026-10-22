interface ImportMetaEnv {
  readonly VITE_OPENCODE_SERVER_MODE?: "none" | "origin"
  readonly VITE_OPENCODE_SERVER_HOST: string
  readonly VITE_OPENCODE_SERVER_PORT: string
  // OpenSession: a full server URL, e.g. a cloud project behind the gateway (<gateway>/p/<project>).
  readonly VITE_OPENCODE_SERVER_URL?: string
  // OpenSession accounts (src/opensession): the gateway and the Better Auth server. Both set = sign-in first.
  readonly VITE_OPENSESSION_GATEWAY_URL?: string
  readonly VITE_OPENSESSION_AUTH_URL?: string
  readonly VITE_OPENCODE_CHANNEL?: "local" | "dev" | "beta" | "prod"

  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_ENVIRONMENT?: string
  readonly VITE_SENTRY_RELEASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "*.png" {
  const src: string
  export default src
}

declare module "*.mp4" {
  const src: string
  export default src
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }

    // The Element Timing attribute, which Solid's DOM types do not list.
    interface ImgHTMLAttributes<T> {
      elementtiming?: string
    }
  }
}
