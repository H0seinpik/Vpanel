import { NextResponse } from 'next/server';
import { toAppError } from './errors';

/** Success envelope. Every API response uses `{ data, ... }` or `{ error }`. */
export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, { status: 200, ...init });
}

export function jsonCreated<T>(data: T): NextResponse {
  return NextResponse.json({ data }, { status: 201 });
}

export function jsonNoContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

export interface Paginated<T> {
  items: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export function paginate<T>(items: T[], total: number, page: number, pageSize: number): Paginated<T> {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

export function jsonPaginated<T>(result: Paginated<T>): NextResponse {
  return NextResponse.json({ data: result.items, pagination: result.pagination });
}

/** Central error responder — converts any thrown value into a safe response. */
export function jsonError(error: unknown): NextResponse {
  const appError = toAppError(error);

  // Log server-side; never return internals to the client.
  if (appError.status >= 500) {
    console.error('[api] unhandled error:', error);
  }

  const headers: Record<string, string> = {};
  if (appError.status === 429) {
    const retryAfter = (appError.details as { retryAfterSeconds?: number } | undefined)
      ?.retryAfterSeconds;
    headers['Retry-After'] = String(retryAfter ?? 60);
  }

  return NextResponse.json(
    {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details ? { details: appError.details } : {}),
      },
    },
    { status: appError.status, headers },
  );
}

/** Parse `?page=&pageSize=` with sane bounds. */
export function parsePagination(url: URL, defaults = { page: 1, pageSize: 20, maxPageSize: 100 }) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? defaults.page) || defaults.page);
  const pageSize = Math.min(
    defaults.maxPageSize,
    Math.max(1, Number(url.searchParams.get('pageSize') ?? defaults.pageSize) || defaults.pageSize),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
