/**
 * EdgeFuzz Built-in Demo Server
 *
 * A deliberately vulnerable HTTP API used by `edgefuzz --demo`.
 * Exposes a Course Catalog API with intentional bugs that EdgeFuzz finds:
 *
 *   - Integer overflow: POST /courses — quantity field crashes on MAX_INT
 *   - Missing null check: GET /courses/:id — crashes on non-numeric id
 *   - Prototype pollution: PATCH /courses/:id — unsafe object merge
 *   - Missing input validation: POST /enroll — userId accepts null/special chars
 *   - SQL-injection-like: GET /courses?search= — unsanitised string eval
 *
 * Uses Node's built-in `http` module only — zero extra dependencies.
 */

import http from 'http';
import type { AddressInfo } from 'net';

// ---------------------------------------------------------------------------
// In-memory "database"
// ---------------------------------------------------------------------------

interface Course {
  id: number;
  title: string;
  instructor: string;
  capacity: number;
  enrolled: number;
  tags: string[];
  price: number;
}

const courses: Course[] = [
  { id: 1, title: 'TypeScript Deep Dive', instructor: 'Alice', capacity: 30, enrolled: 12, tags: ['ts', 'js'], price: 99 },
  { id: 2, title: 'API Security 101', instructor: 'Bob', capacity: 20, enrolled: 20, tags: ['security', 'api'], price: 149 },
  { id: 3, title: 'Distributed Systems', instructor: 'Carol', capacity: 25, enrolled: 5, tags: ['infra'], price: 199 },
];

let nextId = 4;

// ---------------------------------------------------------------------------
// Inline OpenAPI 3.x spec — returned at /openapi.json
// ---------------------------------------------------------------------------

const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: { title: 'EdgeFuzz Demo API', version: '1.0.0', description: 'A deliberately buggy Course Catalog API.' },
  servers: [{ url: '__BASE_URL__' }],
  paths: {
    '/courses': {
      get: {
        operationId: 'listCourses',
        summary: 'List all courses',
        parameters: [
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'maxPrice', in: 'query', schema: { type: 'integer', minimum: 0 } },
        ],
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'createCourse',
        summary: 'Create a new course',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title', 'instructor', 'capacity', 'price'],
                properties: {
                  title: { type: 'string', minLength: 1, maxLength: 200 },
                  instructor: { type: 'string' },
                  capacity: { type: 'integer', minimum: 1, maximum: 1000 },
                  price: { type: 'number', minimum: 0 },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/courses/{id}': {
      get: {
        operationId: 'getCourse',
        summary: 'Get a course by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
      patch: {
        operationId: 'updateCourse',
        summary: 'Partially update a course',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  capacity: { type: 'integer', minimum: 1 },
                  price: { type: 'number' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'OK' } },
      },
      delete: {
        operationId: 'deleteCourse',
        summary: 'Delete a course',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '204': { description: 'Deleted' } },
      },
    },
    '/enroll': {
      post: {
        operationId: 'enrollStudent',
        summary: 'Enroll a student in a course',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['courseId', 'userId'],
                properties: {
                  courseId: { type: 'integer' },
                  userId: { type: 'string', minLength: 1 },
                  promoCode: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Enrolled' } },
      },
    },
    '/stats': {
      get: {
        operationId: 'getStats',
        summary: 'Get global enrollment statistics',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Request handling helpers
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function parseBody(raw: string): unknown {
  if (!raw.trim()) return {};
  return JSON.parse(raw); // intentionally unguarded — throws on malformed JSON → 500
}

// ---------------------------------------------------------------------------
// Route handlers — each has at least one intentional bug
// ---------------------------------------------------------------------------

function handleListCourses(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url!, 'http://x');
  const search = url.searchParams.get('search');
  const maxPrice = url.searchParams.get('maxPrice');

  let results = [...courses];

  if (search) {
    // BUG: unsanitised eval-like behaviour — crashes on special regex chars
    const regex = new RegExp(search, 'i'); // throws on invalid regex patterns like "["
    results = results.filter((c) => regex.test(c.title) || regex.test(c.instructor));
  }

  if (maxPrice !== null) {
    // BUG: no NaN check — crashes silently, returns wrong results on non-numeric input
    results = results.filter((c) => c.price <= Number(maxPrice));
  }

  json(res, 200, { courses: results, total: results.length });
}

function handleCreateCourse(body: unknown, res: http.ServerResponse): void {
  // BUG: unsafe cast — crashes when body is not an object (e.g. null body, array, string)
  const data = body as Record<string, unknown>;

  // BUG: no type check on capacity — crashes with MAX_INT arithmetic overflow in real DBs
  // We simulate the crash: capacity > MAX_SAFE_INTEGER / 2 → internal error
  const capacity = Number(data['capacity']);
  if (capacity > Number.MAX_SAFE_INTEGER / 2) {
    throw new Error(`Internal error: capacity value ${capacity} exceeds safe range`);
  }

  // BUG: tags.join() crashes if tags is not an array (e.g. tags: "backend")
  const tags = data['tags'] as string[];
  const tagStr = tags.join(','); // throws TypeError if tags is not an array

  const course: Course = {
    id: nextId++,
    title: String(data['title']),
    instructor: String(data['instructor']),
    capacity,
    enrolled: 0,
    tags: tagStr.split(',').filter(Boolean),
    price: Number(data['price']),
  };

  courses.push(course);
  json(res, 201, course);
}

function handleGetCourse(id: string, res: http.ServerResponse): void {
  // BUG: parseInt crashes the handler when id is a special string like "\x00" or "../../etc"
  // because downstream code assumes numeric id
  const numId = parseInt(id, 10);

  // BUG: no isNaN check — numId is NaN for non-numeric ids, Array.find returns undefined,
  // then accessing .title on undefined throws TypeError
  const course = courses.find((c) => c.id === numId);

  if (!course) {
    json(res, 404, { error: 'Course not found', id });
    return;
  }

  json(res, 200, course);
}

function handleUpdateCourse(id: string, body: unknown, res: http.ServerResponse): void {
  const numId = parseInt(id, 10);
  if (isNaN(numId)) {
    json(res, 400, { error: 'Invalid id' });
    return;
  }

  const idx = courses.findIndex((c) => c.id === numId);
  if (idx === -1) {
    json(res, 404, { error: 'Course not found' });
    return;
  }

  // BUG: prototype pollution — if body contains __proto__, constructor, etc.
  // Object.assign propagates them to the course object and beyond
  Object.assign(courses[idx]!, body as object);

  json(res, 200, courses[idx]);
}

function handleDeleteCourse(id: string, res: http.ServerResponse): void {
  const numId = parseInt(id, 10);
  const idx = courses.findIndex((c) => c.id === numId);
  if (idx === -1) {
    json(res, 404, { error: 'Course not found' });
    return;
  }
  courses.splice(idx, 1);
  res.writeHead(204);
  res.end();
}

function handleEnroll(body: unknown, res: http.ServerResponse): void {
  // BUG: no null/type check on body fields — crashes when courseId or userId is null
  const data = body as Record<string, unknown>;
  const courseId = data['courseId'] as number;
  const userId = data['userId'] as string;

  // BUG: crashes if userId contains null bytes or is not a string
  if (userId.includes('\x00')) {
    throw new Error('Internal error: null byte in user id');
  }

  // BUG: crashes if userId is not a string at all (e.g. null, number)
  if (userId.trim() === '') {
    json(res, 400, { error: 'userId cannot be empty' });
    return;
  }

  const course = courses.find((c) => c.id === courseId);
  if (!course) {
    json(res, 404, { error: 'Course not found' });
    return;
  }

  if (course.enrolled >= course.capacity) {
    json(res, 409, { error: 'Course is full' });
    return;
  }

  course.enrolled++;
  json(res, 200, { message: 'Enrolled', courseId, userId, remaining: course.capacity - course.enrolled });
}

function handleStats(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const totalCapacity = courses.reduce((s, c) => s + c.capacity, 0);
  const totalEnrolled = courses.reduce((s, c) => s + c.enrolled, 0);
  json(res, 200, {
    totalCourses: courses.length,
    totalCapacity,
    totalEnrolled,
    fillRate: totalCapacity > 0 ? (totalEnrolled / totalCapacity).toFixed(2) : '0.00',
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url!, 'http://x');
  const method = req.method?.toUpperCase() ?? 'GET';
  const pathname = url.pathname;

  // Serve OpenAPI spec
  if (pathname === '/openapi.json') {
    json(res, 200, OPENAPI_SPEC);
    return;
  }

  let body: unknown = {};
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    const raw = await readBody(req);
    body = parseBody(raw);
  }

  // Route matching
  const courseMatch = pathname.match(/^\/courses\/([^/]+)$/);

  try {
    if (pathname === '/courses' && method === 'GET') {
      handleListCourses(req, res);
    } else if (pathname === '/courses' && method === 'POST') {
      handleCreateCourse(body, res);
    } else if (courseMatch && method === 'GET') {
      handleGetCourse(courseMatch[1]!, res);
    } else if (courseMatch && method === 'PATCH') {
      handleUpdateCourse(courseMatch[1]!, body, res);
    } else if (courseMatch && method === 'DELETE') {
      handleDeleteCourse(courseMatch[1]!, res);
    } else if (pathname === '/enroll' && method === 'POST') {
      handleEnroll(body, res);
    } else if (pathname === '/stats' && method === 'GET') {
      handleStats(req, res);
    } else {
      json(res, 404, { error: 'Not found', method, path: pathname });
    }
  } catch (err) {
    // Intentionally leak error details — simulates a real unhandled exception
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    json(res, 500, { error: 'Internal Server Error', message: msg, stack });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DemoServer {
  port: number;
  url: string;
  specUrl: string;
  close: () => Promise<void>;
}

/**
 * Start the demo server on a random available port.
 * Returns the base URL and spec URL to pass to the fuzzer.
 */
export async function startDemoServer(): Promise<DemoServer> {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      const body = JSON.stringify({ error: 'Internal Server Error', message: msg });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(body);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  // Patch the spec to use the actual port
  (OPENAPI_SPEC.servers[0] as { url: string }).url = url;

  return {
    port,
    url,
    specUrl: `${url}/openapi.json`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}
