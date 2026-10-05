import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The deployment files refer to each other and to the code by name. These checks fail when one of them drifts.

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const dockerfile = read('Dockerfile');
const render = read('render.yaml');

describe('Dockerfile', () => {
  it('uses the Node major from .nvmrc and starts through the entrypoint that drops privileges', () => {
    const major = read('.nvmrc').trim().split('.')[0];
    expect(dockerfile.match(/^FROM node:(\d+)/gm)).toEqual([`FROM node:${major}`, `FROM node:${major}`]);
    expect(dockerfile).toContain('ENTRYPOINT ["docker-entrypoint.sh"]');
    expect(dockerfile).toContain('COPY docker-entrypoint.sh');
    expect(statSync(new URL('../../docker-entrypoint.sh', import.meta.url)).mode & 0o111).not.toBe(0);
  });

  it('binds to every interface (the server then insists on a password) and keeps data in /app/data', () => {
    expect(dockerfile).toMatch(/ENV HOST=0\.0\.0\.0 .*DATA_DIR=\/app\/data/);
  });
});

describe('the server bundle', () => {
  it('is built together with its page-extraction worker, which the image carries to the place the server looks', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['build:server']).toBe('tsx scripts/build-server.ts');
    expect(scripts.build).toContain('build:server');
    expect(scripts.start).toBe('node dist/server.mjs');
    const build = read('scripts/build-server.ts');
    expect(build).toContain("server: 'src/server/index.ts'");
    expect(build).toContain("'extract-worker': 'src/server/crawl/extract-worker.ts'");
    expect(read('src/server/crawl/extract-pool.ts')).toContain("new URL('./extract-worker.mjs', import.meta.url)");
    expect(dockerfile).toContain('COPY --from=build /app/dist ./dist'); // the whole folder, so the worker travels with the server
    expect(dockerfile).toContain('CMD ["node", "dist/server.mjs"]');
  });
});

describe('render.yaml', () => {
  it('health-checks a route the server really has, and that route is exempt from the password', () => {
    const path = render.match(/healthCheckPath: (\S+)/)?.[1];
    expect(path).toBe('/api/health');
    const app = read('src/server/app.ts');
    expect(app).toContain(`app.get('${path}'`);
    expect(app).toContain(`c.req.path === '${path}'`);
  });

  it('sets only variables the server reads, keeps keys out of the file and generates the password', () => {
    const keys = [...render.matchAll(/- key: (\w+)/g)].map((m) => m[1] as string);
    expect(keys).toEqual(['JEV_API_KEY', 'SERPER_API_KEY', 'APP_PASSWORD']);
    const config = read('src/server/config.ts');
    for (const key of keys) expect(config).toContain(key);
    expect(render).toMatch(/- key: JEV_API_KEY\n\s+sync: false/);
    expect(render).toMatch(/- key: SERPER_API_KEY\n\s+sync: false/);
    expect(render).toMatch(/- key: APP_PASSWORD\n\s+generateValue: true/);
    expect(render).not.toMatch(/value:\s*\S/); // no literal secret values anywhere in the blueprint
  });

  it('mounts the (optional) disk exactly where the image keeps its data', () => {
    const mount = render.match(/#\s+mountPath: (\S+)/)?.[1];
    const data = dockerfile.match(/DATA_DIR=(\S+)/)?.[1];
    expect(mount).toBeDefined();
    expect(mount).toBe(data);
  });

  it('builds the Dockerfile that exists', () => {
    expect(render).toContain('runtime: docker');
    expect(render).toContain('dockerfilePath: ./Dockerfile');
  });
});
