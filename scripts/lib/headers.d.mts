export interface PublicOrigin {
  origin: string;
  wssOrigin: string;
  socketOrigin: string;
}

export interface HeaderHosts {
  connectOrigins: string[];
  imageHosts: string[];
}

export function publicOriginFor(environment: string | undefined, publicOrigin: string | undefined): PublicOrigin;
export function renderHeaders(source: string, values: PublicOrigin, hosts?: HeaderHosts): string;
