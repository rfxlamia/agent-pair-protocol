export type TransformResponse = (path: string, res: Response) => Response | Promise<Response>;

export interface InProcessApp {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
}

let originalFetch: typeof fetch | undefined;
let installedBase: string | undefined;

export function installInProcessFetch(
  baseUrl: string,
  app: InProcessApp,
  options?: { transformResponse?: TransformResponse },
): void {
  originalFetch = globalThis.fetch;
  installedBase = baseUrl.replace(/\/$/, "");

  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    const base = new URL(installedBase as string);
    if (url.origin !== base.origin) {
      return (originalFetch as typeof fetch)(input, init);
    }

    const path = url.pathname + url.search;
    let res = await app.request(path, init);
    if (options?.transformResponse) {
      res = await options.transformResponse(path, res);
    }
    return res;
  };
}

export function uninstallInProcessFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
    installedBase = undefined;
  }
}
