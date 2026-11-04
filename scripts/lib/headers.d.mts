export interface PublicOrigin {
  origin: string;
  wssOrigin: string;
}

export function publicOriginFor(environment: string | undefined, publicOrigin: string | undefined): PublicOrigin;
export function renderHeaders(source: string, values: PublicOrigin): string;
