/** JSON 境界の入力検証と認証を行い、秘密値をログへ出さない HTTP API。 */
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import { getAppCheck } from "firebase-admin/app-check";
import { logger } from "firebase-functions";
import { z } from "zod";
import { RoomRepository } from "./repository.js";
import { ApiError } from "./errors.js";
const entry = z
  .object({
    displayName: z.string().trim().min(1).max(24),
    passcode: z.string().min(6).max(64),
  })
  .strict();
const roomCode = z.string().regex(/^[A-F0-9]{12}$/);
// 行動 ID はクライアントごとに生成する UUID とし、Firestore のパスとして安全に扱う。
const placementInput = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    direction: z.enum(["N", "E", "S", "W"]),
  })
  .strict();
const actionInput = z
  .object({
    actionId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    action: z.enum([
      "MOVE_FORWARD",
      "TURN_LEFT",
      "TURN_RIGHT",
      "ACTIVE_SONAR",
      "FIRE_TORPEDO",
    ]),
  })
  .strict();
/** Authorization ヘッダー以外からの token 入力を禁止する。 */
function bearer(req: Request, required = true): string | undefined {
  const value = req.get("authorization");
  if (!value && !required) return undefined;
  if (!value || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value))
    throw new ApiError(401, "INVALID_TOKEN", "再接続情報が必要です。");
  return value.slice(7);
}
/** repository を注入して本番関数と統合テストで同じ API を使う。 */
export function createApp(
  repository: RoomRepository,
  appCheckMode: "off" | "monitor" | "enforce" = "off",
  verifyAppCheck: (token: string) => Promise<unknown> = (token) =>
    getAppCheck().verifyToken(token),
) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    // 同一オリジンのブラウザだけが更新できる。API テスト等の Origin 未指定は許可する。
    const origin = req.get("origin");
    // Hosting rewrite は Host を関数側へ変更するため、元の配信ホストを使う。
    const host = req.get("x-forwarded-host") ?? req.get("host");
    if (origin && (!URL.canParse(origin) || new URL(origin).host !== host))
      return next(
        new ApiError(403, "INVALID_ORIGIN", "同じサイトから操作してください。"),
      );
    next();
  });
  app.use(express.json({ limit: "4kb" }));
  // health は外部監視に公開し、ゲーム API だけを検証対象にする。
  app.use((req, res, next) => {
    if (appCheckMode === "off" || req.path === "/api/v1/health") {
      next();
      return;
    }
    const token = req.get("X-Firebase-AppCheck");
    if (!token) {
      logger.warn("app_check_rejected", { reason: "missing", requestId: res.locals.requestId });
      if (appCheckMode === "enforce") return next(new ApiError(401, "APP_CHECK_REQUIRED", "接続を確認してください。"));
      next();
      return;
    }
    verifyAppCheck(token)
      .then(() => next())
      .catch(() => {
        // token と検証例外には秘密値が含まれ得るため、理由分類のみ記録する。
        logger.warn("app_check_rejected", { reason: "invalid", requestId: res.locals.requestId });
        if (appCheckMode === "enforce")
          next(new ApiError(401, "APP_CHECK_INVALID", "接続を確認してください。"));
        else next();
      });
  });
  /** 非同期の失敗を統一エラーハンドラへ引き渡す。 */
  const route =
    (handler: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      handler(req, res).catch(next);
    };
  app.get("/api/v1/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.post(
    "/api/v1/rooms",
    route(async (req, res) => {
      await repository.rateLimit(`create:${req.ip}`, 20);
      const data = entry.parse(req.body);
      res
        .status(201)
        .json(await repository.create(data.displayName, data.passcode));
    }),
  );
  app.post(
    "/api/v1/rooms/:code/join",
    route(async (req, res) => {
      const code = roomCode.parse(String(req.params.code).toUpperCase());
      await repository.rateLimit(`join:${req.ip}`, 15);
      await repository.rateLimit(`join-room:${code}`, 30);
      const data = entry.parse(req.body);
      res.json(
        await repository.join(
          code,
          data.displayName,
          data.passcode,
          bearer(req, false),
        ),
      );
    }),
  );
  app.get(
    "/api/v1/rooms/:code/state",
    route(async (req, res) => {
      const code = roomCode.parse(String(req.params.code).toUpperCase());
      const token = bearer(req)!;
      await repository.rateLimit(`state:${code}:${token}`, 90);
      const state = await repository.state(code, token);
      const etag = `"${state.version}"`;
      res.set("ETag", etag);
      if (req.get("if-none-match") === etag) {
        res.status(304).end();
        return;
      }
      res.json(state);
    }),
  );
  app.post(
    "/api/v1/rooms/:code/placement",
    route(async (req, res) => {
      const code = roomCode.parse(String(req.params.code).toUpperCase());
      const pose = placementInput.parse(req.body);
      res.json(await repository.placement(code, bearer(req)!, pose));
    }),
  );
  app.post(
    "/api/v1/rooms/:code/actions",
    route(async (req, res) => {
      const code = roomCode.parse(String(req.params.code).toUpperCase());
      const data = actionInput.parse(req.body);
      await repository.rateLimit(`action:${code}:${bearer(req)!}`, 30);
      res.json(
        await repository.action(
          code,
          bearer(req)!,
          data.actionId,
          data.expectedVersion,
          data.action,
        ),
      );
    }),
  );
  app.post(
    "/api/v1/rooms/:code/leave",
    route(async (req, res) => {
      const code = roomCode.parse(String(req.params.code).toUpperCase());
      await repository.leave(code, bearer(req)!);
      res.status(204).end();
    }),
  );
  app.use((_req, _res, next) => {
    next(new ApiError(404, "NOT_FOUND", "API が見つかりません。"));
  });
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const invalid =
        error instanceof z.ZodError || error instanceof SyntaxError;
      const tooLarge =
        typeof error === "object" &&
        error !== null &&
        "type" in error &&
        error.type === "entity.too.large";
      const known =
        error instanceof ApiError
          ? error
          : invalid || tooLarge
            ? new ApiError(400, "INVALID_INPUT", "入力内容を確認してください。")
            : new ApiError(500, "INTERNAL_ERROR", "処理に失敗しました。");
      res.status(known.status).json({
        code: known.code,
        message: known.message,
        requestId: res.locals.requestId,
      });
    },
  );
  return app;
}
