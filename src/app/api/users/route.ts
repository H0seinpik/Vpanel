import { readJson, withAuth } from '@/lib/api/handler';
import { jsonCreated, jsonPaginated, paginate, parsePagination } from '@/lib/api/response';
import { createUserSchema, userQuerySchema } from '@/lib/validation';
import { serializeUser } from '@/server/serializers';
import { createUser, listUsers } from '@/server/services/user-service';

/**
 * GET  /api/users   — paginated, searchable, filterable list (users:read)
 * POST /api/users   — create a user (users:write)
 */
export const GET = withAuth(
  async (req) => {
    const url = new URL(req.url);
    const query = userQuerySchema.parse(Object.fromEntries(url.searchParams));
    const pagination = parsePagination(url);

    const { items, total } = await listUsers(query, pagination);

    return jsonPaginated(
      paginate(items.map(serializeUser), total, pagination.page, pagination.pageSize),
    );
  },
  { capability: 'users:read', rate: 'read' },
);

export const POST = withAuth(
  async (req, { user, meta }) => {
    const input = createUserSchema.parse(await readJson(req));
    const created = await createUser(input, {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return jsonCreated(serializeUser(created));
  },
  { capability: 'users:write', rate: 'write' },
);
