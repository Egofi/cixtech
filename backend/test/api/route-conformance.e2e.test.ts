import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  ADMIN_ROUTES,
  AUTH_ROUTES,
  ROUTE_ACCESS,
  ROUTE_KEYS,
  SYSTEM_ROUTES,
  TENANT_ROUTES,
  routeKey,
} from "@/common/routes";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { makeApi } from "./harness.js";

const CONSTS: Record<string, Record<string, string>> = {
  ADMIN_ROUTES,
  AUTH_ROUTES,
  SYSTEM_ROUTES,
  TENANT_ROUTES,
};

function registeredInSource(): { keys: string[]; literals: string[] } {
  const files = execSync(
    "grep -rl 'app\\.\\(get\\|post\\|put\\|patch\\|delete\\)(' --include='*.ts' src/api",
  )
    .toString()
    .trim()
    .split("\n");
  const keys: string[] = [];
  const literals: string[] = [];
  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["get", "post", "put", "patch", "delete"].includes(node.expression.name.text) &&
        node.arguments.length > 0
      ) {
        const method = node.expression.name.text.toUpperCase();
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg) && arg.text.startsWith("/")) {
          literals.push(`${f}: ${method} ${arg.text}`);
        } else if (arg && ts.isPropertyAccessExpression(arg)) {
          const group = CONSTS[arg.expression.getText()];
          const path = group?.[arg.name.text];
          if (path) keys.push(routeKey(method, path));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { keys, literals };
}

const fill = (path: string): string => path.replace(/:\w+/g, "test-id");

describe("the routes folder is the only place a path is written", () => {
  it("leaves no route path as a bare string literal", () => {
    expect(registeredInSource().literals).toEqual([]);
  });

  it("registers nothing the catalogue has not declared", () => {
    const declared = new Set<string>(ROUTE_KEYS);
    const undeclared = registeredInSource().keys.filter((k) => !declared.has(k));
    expect(undeclared).toEqual([]);
  });

  it("declares nothing the app does not actually serve", async () => {
    const ctx = await makeApi();
    const missing = ROUTE_KEYS.filter((k) => {
      const [method, path] = k.split(" ") as [string, string];
      return !ctx.app.hasRoute({ method: method as "GET", url: path });
    });
    expect(missing).toEqual([]);
  });
});

describe("no privileged route answers an anonymous caller", () => {
  const anonymous = async (keys: readonly string[]): Promise<string[]> => {
    const ctx = await makeApi();
    const served: string[] = [];
    for (const key of keys) {
      const [method, path] = key.split(" ") as [string, string];
      const res = await ctx.app.inject({ method: method as "GET", url: fill(path), payload: {} });
      if (res.statusCode !== 401 && res.statusCode !== 403)
        served.push(`${key} -> ${res.statusCode}`);
    }
    return served;
  };

  it("refuses every operator route", async () => {
    const keys = ROUTE_KEYS.filter((k) => ROUTE_ACCESS[k].kind === "operator");
    expect(keys.length).toBeGreaterThan(30);
    expect(await anonymous(keys), "admin routes reachable with no credential").toEqual([]);
  });

  it("refuses every tenant route", async () => {
    const keys = ROUTE_KEYS.filter((k) => ROUTE_ACCESS[k].kind === "tenant");
    expect(keys.length).toBeGreaterThan(15);
    expect(await anonymous(keys), "tenant routes reachable with no API key").toEqual([]);
  });

  it("refuses every route behind the shared admin token", async () => {
    const keys = ROUTE_KEYS.filter((k) => ROUTE_ACCESS[k].kind === "admin-token");
    expect(keys.length).toBeGreaterThan(0);
    expect(await anonymous(keys)).toEqual([]);
  });

  it("never refuses an open route for want of a credential", async () => {
    const ctx = await makeApi();
    for (const key of ROUTE_KEYS.filter((k) => ROUTE_ACCESS[k].kind === "public")) {
      const [method, path] = key.split(" ") as [string, string];
      const res = await ctx.app.inject({ method: method as "GET", url: fill(path), payload: {} });
      const code = res.body.startsWith("{") ? (res.json().error?.code ?? null) : null;
      expect(code, `${key} was refused as unauthenticated`).not.toBe("UNAUTHORIZED");
      expect(code, `${key} was refused as unauthenticated`).not.toBe("NOT_AUTHENTICATED");
    }
  });
});
