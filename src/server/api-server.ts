import type { Server } from "node:http";

import express, { type Express } from "express";

import { AgentHandler } from "../agent/agent-handler.js";
import { AgentName } from "../agent/types.js";
import { t } from "../i18n/index.js";
import type { TunnelManager } from "../tunnel/tunnel-manager.js";
import { ApiRoute, isWindows, MINI_APP_BASE_URL } from "../utils/constants.js";
import { eventCollector } from "../utils/event-collector.js";
import { logger } from "../utils/log.js";
import { responseStore } from "../utils/response-store.js";

const ALLOWED_CORS_ORIGIN = new URL(MINI_APP_BASE_URL).origin;

export class ApiServer {
  private app: Express;
  private server: Server | null = null;
  private port: number;
  private secret: string;
  private handler: AgentHandler | null = null;
  private tunnelManager: TunnelManager | null = null;

  constructor(port: number, secret: string) {
    this.port = port;
    this.secret = secret;
    this.app = this.createApp();
  }

  setHandler(handler: AgentHandler): void {
    this.handler = handler;
  }

  setTunnelManager(tunnelManager: TunnelManager): void {
    this.tunnelManager = tunnelManager;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, "127.0.0.1", () => {
        logger.info(t("hook.serverListening", { port: this.port }));
        resolve();
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          const killCommand = isWindows()
            ? `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${this.port} ^| findstr LISTENING') do taskkill /PID %a /F`
            : `kill $(lsof -ti:${this.port})`;
          logger.error(t("bot.alreadyRunning", { port: this.port, killCommand }));
          process.exit(1);
        }
        reject(err);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  private createApp(): Express {
    const app = express();
    app.use(express.json({ limit: "256kb" }));
    app.use(
      (
        err: Error & { status?: number; type?: string },
        _req: express.Request,
        res: express.Response,
        next: express.NextFunction
      ) => {
        if (err.type === "entity.parse.failed") {
          logger.debug(`[API] malformed JSON body: ${err.message}`);
          res.status(400).json({ error: "invalid_json" });
          return;
        }
        next(err);
      }
    );
    app.options(ApiRoute.ResponseData, (_req, res) => {
      res
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", "ngrok-skip-browser-warning")
        .header("Access-Control-Allow-Methods", "GET, OPTIONS")
        .status(204)
        .end();
    });
    app.get(ApiRoute.ResponseData, (req, res) => {
      logger.debug(
        `[API] GET ${ApiRoute.ResponseData} id=${req.params.id} origin=${req.headers.origin ?? "none"}`
      );
      const requestOrigin = req.headers.origin ?? "";
      const tunnelUrl = this.tunnelManager?.getPublicUrl();
      const tunnelOrigin = tunnelUrl ? new URL(tunnelUrl).origin : null;
      const allowedOrigin =
        requestOrigin === ALLOWED_CORS_ORIGIN
          ? ALLOWED_CORS_ORIGIN
          : tunnelOrigin && requestOrigin === tunnelOrigin
            ? tunnelOrigin
            : ALLOWED_CORS_ORIGIN;
      res.header("Access-Control-Allow-Origin", allowedOrigin);
      const data = responseStore.get(req.params.id);
      if (!data) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(data);
    });

    app.post(ApiRoute.HookStop, (req, res) => {
      logger.debug(
        `[API] POST ${ApiRoute.HookStop} ip=${req.ip} agent=${req.query.agent ?? "(none)"}`
      );
      const receivedSecret = req.headers["x-ccpoke-secret"];
      if (receivedSecret !== this.secret) {
        logger.debug(`[API] forbidden: secret mismatch on ${ApiRoute.HookStop}`);
        res.status(403).send("forbidden");
        return;
      }

      const agentName = req.query.agent ? `${req.query.agent}` : AgentName.ClaudeCode;
      logger.debug(`[API] ${ApiRoute.HookStop} accepted agent=${agentName}`);
      eventCollector.collect("hook-stop", req.body, agentName);

      setImmediate(() => {
        this.handler?.handleStopEvent(agentName, req.body).catch((err: unknown) => {
          logger.error({ err }, t("hook.stopEventFailed"));
        });
      });
      res.status(200).send("ok");
    });

    app.post(ApiRoute.HookSessionStart, (req, res) => {
      logger.debug(
        `[API] POST ${ApiRoute.HookSessionStart} ip=${req.ip} sessionId=${req.body?.session_id ?? "?"}`
      );
      const receivedSecret = req.headers["x-ccpoke-secret"];
      if (receivedSecret !== this.secret) {
        logger.debug(`[API] forbidden: secret mismatch on ${ApiRoute.HookSessionStart}`);
        res.status(403).send("forbidden");
        return;
      }

      logger.debug(`[API] ${ApiRoute.HookSessionStart} accepted`);
      eventCollector.collect("hook-session-start", req.body);
      setImmediate(() => {
        this.handler?.handleSessionStart(req.body).catch((err: unknown) => {
          logger.error({ err }, t("hook.sessionStartFailed"));
        });
      });
      res.status(200).send("ok");
    });

    app.post(ApiRoute.HookNotification, (req, res) => {
      logger.debug(
        `[API] POST ${ApiRoute.HookNotification} ip=${req.ip} sessionId=${req.body?.session_id ?? "?"}`
      );
      const receivedSecret = req.headers["x-ccpoke-secret"];
      if (receivedSecret !== this.secret) {
        logger.debug(`[API] forbidden: secret mismatch on ${ApiRoute.HookNotification}`);
        res.status(403).send("forbidden");
        return;
      }

      logger.debug(`[API] ${ApiRoute.HookNotification} accepted`);
      eventCollector.collect("hook-notification", req.body);
      setImmediate(() => {
        this.handler?.handleNotification(req.body).catch((err: unknown) => {
          logger.error({ err }, t("hook.notificationHookFailed"));
        });
      });
      res.status(200).send("ok");
    });

    app.post(ApiRoute.HookAskUserQuestion, (req, res) => {
      logger.debug(
        `[API] POST ${ApiRoute.HookAskUserQuestion} ip=${req.ip} sessionId=${req.body?.session_id ?? "?"}`
      );
      const receivedSecret = req.headers["x-ccpoke-secret"];
      if (receivedSecret !== this.secret) {
        logger.debug(`[API] forbidden: secret mismatch on ${ApiRoute.HookAskUserQuestion}`);
        res.status(403).send("forbidden");
        return;
      }

      logger.debug(`[API] ${ApiRoute.HookAskUserQuestion} accepted`);
      eventCollector.collect("hook-ask-user-question", req.body);
      const agentName = typeof req.query.agent === "string" ? req.query.agent : undefined;
      setImmediate(() => {
        this.handler
          ?.handleAskUserQuestion({ ...req.body, agent: agentName })
          .catch((err: unknown) => {
            logger.error({ err }, t("askQuestion.hookFailed"));
          });
      });
      res.status(200).send("ok");
    });

    app.post(ApiRoute.HookPermissionRequest, (req, res) => {
      logger.debug(
        `[API] POST ${ApiRoute.HookPermissionRequest} ip=${req.ip} sessionId=${req.body?.session_id ?? "?"}`
      );
      const receivedSecret = req.headers["x-ccpoke-secret"];
      if (receivedSecret !== this.secret) {
        logger.debug(`[API] forbidden: secret mismatch on ${ApiRoute.HookPermissionRequest}`);
        res.status(403).send("forbidden");
        return;
      }

      logger.debug(`[API] ${ApiRoute.HookPermissionRequest} accepted`);
      eventCollector.collect("hook-permission-request", req.body);
      setImmediate(() => {
        this.handler?.handlePermissionRequest(req.body).catch((err: unknown) => {
          logger.error({ err }, t("hook.permissionRequestFailed"));
        });
      });
      res.status(200).send("ok");
    });

    app.get(ApiRoute.Health, (_req, res) => {
      logger.debug(`[API] GET ${ApiRoute.Health}`);
      res.status(200).send("healthy");
    });

    return app;
  }
}
