/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * Static export — no Node runtime in the image.
   *
   * Every page here is behind a credential the browser holds (an admin bearer
   * token or a tenant API key, in localStorage) and every byte of data comes from
   * a separate cross-origin API. There is nothing to render on a server: no SEO
   * surface, no session cookie to read, and no way to fetch a tenant's data
   * server-side without forwarding their credential to a second machine.
   *
   * So the output is plain files behind nginx, exactly as before. That keeps the
   * image at ~75MB with no Node process, and — more to the point — keeps a server
   * that handles admin tokens out of the deployment entirely.
   */
  output: "export",

  // Static hosting serves /admin/ as /admin/index.html; trailing slashes keep
  // relative asset paths and nginx's try_files behaviour consistent.
  trailingSlash: true,

  images: { unoptimized: true },

  // The consoles are typechecked and linted by `pnpm check`; failing the build on
  // the same errors twice just makes the failure slower to read.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
