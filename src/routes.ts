import assert from "node:assert";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Agent } from "@atproto/api";
import { AppBskyActorDefs } from "@atproto/api";
import type { SavedFeedsPrefV2 } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import { TID } from "@atproto/common";
import { OAuthResolverError } from "@atproto/oauth-client-node";
import { isValidHandle } from "@atproto/syntax";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { getIronSession } from "iron-session";
import type { AppContext } from "#/index";
import * as Profile from "#/lexicon/types/app/bsky/actor/profile";
import * as Status from "#/lexicon/types/xyz/statusphere/status";
import { env } from "#/lib/env";
import { page } from "#/lib/view";
import { blank } from "#/pages/blank";
import { home } from "#/pages/home";
import { login } from "#/pages/login";
import { profile } from "#/pages/profile";
import { chat } from "./pages/chat";
import { feeds } from "./pages/feeds";
import { lists } from "./pages/lists";
import { marketplace } from "./pages/marketplace";
import { notifications } from "./pages/notifications";
import { search } from "./pages/search";
import { settings } from "./pages/settings";

const limiter = rateLimit({
	windowMs: 60 * 60 * 1000,
	limit: 1666,
	standardHeaders: "draft-8",
	legacyHeaders: false,
});

type Session = { did: string };

// Helper function for defining routes
const handler =
	(fn: express.Handler) =>
	async (
		req: express.Request,
		res: express.Response,
		next: express.NextFunction,
	) => {
		try {
			await fn(req, res, next);
		} catch (err) {
			next(err);
		}
	};

// Helper function to get the Atproto Agent for the active session
async function getSessionAgent(
	req: IncomingMessage,
	res: ServerResponse<IncomingMessage>,
	ctx: AppContext,
) {
	const session = await getIronSession<Session>(req, res, {
		cookieName: "sid",
		password: env.COOKIE_SECRET,
	});
	if (!session.did) return null;
	try {
		const oauthSession = await ctx.oauthClient.restore(session.did);
		return oauthSession ? new Agent(oauthSession) : null;
	} catch (err) {
		ctx.logger.warn({ err }, "oauth restore failed");
		await session.destroy();
		return null;
	}
}

export const createRouter = (ctx: AppContext) => {
	const router = express.Router();
	router.use(limiter);

	// Static assets
	router.use(
		"/public",
		express.static(path.join(__dirname, "pages", "public")),
	);
	router.use("/js", express.static("./node_modules/bootstrap/dist/js"));
	router.use("/vid", express.static("./node_modules/video.js/dist"));
	router.use("/icons", express.static("./node_modules/bootstrap-icons/font"));
	router.use("/css", express.static("./node_modules/bootswatch/dist/united"));

	// OAuth metadata
	router.get(
		"/client-metadata.json",
		handler((_req, res) => {
			return res.json(ctx.oauthClient.clientMetadata);
		}),
	);

	// OAuth callback to complete session creation
	router.get(
		"/oauth/callback",
		handler(async (req, res) => {
			const params = new URLSearchParams(req.originalUrl.split("?")[1]);
			try {
				const { session } = await ctx.oauthClient.callback(params);
				const clientSession = await getIronSession<Session>(req, res, {
					cookieName: "sid",
					password: env.COOKIE_SECRET,
				});
				assert(!clientSession.did, "session already exists");
				clientSession.did = session.did;
				await clientSession.save();
			} catch (err) {
				ctx.logger.error({ err }, "oauth callback failed");
				return res.redirect("/?error");
			}
			return res.redirect("/");
		}),
	);

	// Login page
	router.get(
		"/login",
		handler(async (_req, res) => {
			return res.type("html").send(page(login({})));
		}),
	);

	// Login handler
	router.post(
		"/login",
		handler(async (req, res) => {
			// Validate
			const handle = req.body?.handle;
			if (typeof handle !== "string" || !isValidHandle(handle)) {
				return res.type("html").send(page(login({ error: "invalid handle" })));
			}

			// Initiate the OAuth flow
			try {
				const url = await ctx.oauthClient.authorize(handle, {
					scope: "atproto transition:generic",
				});
				return res.redirect(url.toString());
			} catch (err) {
				ctx.logger.error({ err }, "oauth authorize failed");
				return res.type("html").send(
					page(
						login({
							error:
								err instanceof OAuthResolverError
									? err.message
									: "couldn't initiate login",
						}),
					),
				);
			}
		}),
	);

	// Logout handler
	router.post(
		"/logout",
		handler(async (req, res) => {
			const session = await getIronSession<Session>(req, res, {
				cookieName: "sid",
				password: env.COOKIE_SECRET,
			});
			await session.destroy();
			return res.redirect("/");
		}),
	);

	// Homepage
	router.get(
		"/",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);

			// Fetch data stored in mongodb
			const db = ctx.dbm.db("statusphere");
			const collection = db.collection("status");
			const statuses = await collection
				.find({})
				.sort({ indexedAt: -1 })
				.toArray()
				.then((docs) =>
					docs.map((doc) => ({
						uri: doc.uri,
						authorDid: doc.authorDid,
						status: doc.status,
						createdAt: doc.createdAt,
						indexedAt: doc.indexedAt,
					})),
				);

			// Map user DIDs to their domain-name handles
			const didHandleMap = await ctx.resolver.resolveDidsToHandles(
				statuses.map((s) => s.authorDid),
			);

			if (!agent) {
				// Serve the logged-out view
				return res.type("html").send(page(login({})));
			}

			// Fetch additional information about the logged-in user
			const { data: profileRecord } = await agent.com.atproto.repo.getRecord({
				repo: agent.assertDid,
				collection: "app.bsky.actor.profile",
				rkey: "self",
			});
			const profile =
				Profile.isRecord(profileRecord.value) &&
				Profile.validateRecord(profileRecord.value).success
					? profileRecord.value
					: {};

			// Serve the logged-in view
			return res.type("html").send(
				page(
					home({
						statuses,
						didHandleMap,
						profile,
					}),
				),
			);
		}),
	);

	// "Set status" handler
	router.post(
		"/status",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);
			if (!agent) {
				return res
					.status(401)
					.type("html")
					.send("<h1>Error: Session required</h1>");
			}

			// Construct & validate their status record
			const rkey = TID.nextStr();
			const record = {
				$type: "xyz.statusphere.status",
				status: req.body?.status,
				createdAt: new Date().toISOString(),
			};
			if (!Status.validateRecord(record).success) {
				return res
					.status(400)
					.type("html")
					.send("<h1>Error: Invalid status</h1>");
			}

			try {
				// Write the status record to the user's repository
				// This is where the new record gets sent to the PDS and goes to the firehose
				const res = await agent.com.atproto.repo.putRecord({
					repo: agent.assertDid,
					collection: "xyz.statusphere.status",
					rkey,
					record,
					validate: false,
				});
				const uri = res.data.uri;
			} catch (err) {
				ctx.logger.warn({ err }, "failed to write record");
				return res
					.status(500)
					.type("html")
					.send("<h1>Error: Failed to write record</h1>");
			}
			return res.redirect("/");
		}),
	);

	// Blank page
	router.get(
		"/blank",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);
			// If the user is not logged in send them to the login page.
			if (!agent) {
				return res.type("html").send(page(login({})));
			}
			return res.type("html").send(page(blank({})));
		}),
	);

	// Marketplace page
	router.get(
		"/marketplace",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);
			// If the user is not logged in send them to the login page.
			if (!agent) {
				return res.type("html").send(page(login({})));
			}
			return res.type("html").send(page(marketplace({})));
		}),
	);

	// Settings page
	router.get(
		"/settings",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);
			// If the user is not logged in send them to the login page.
			if (!agent) {
				return res.type("html").send(page(login({})));
			}
			return res.type("html").send(page(settings({})));
		}),
	);

	// Lists page
	router.get(
		"/lists",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);
			// If the user is not logged in send them to the login page.
			if (!agent) {
				return res.type("html").send(page(login({})));
			}
			return res.type("html").send(page(lists({})));
		}),
	);

	// Feeds page
	router.get(
		"/feeds",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);
			// If the user is not logged in send them to the login page.
			if (!agent) {
				return res.type("html").send(page(login({})));
			}

			const preferences = await agent.app.bsky.actor.getPreferences();
			const { items } = preferences.data.preferences[9] as SavedFeedsPrefV2;

			return res.type("html").send(page(feeds({ items })));
		}),
	);

	router.post(
		"/feeds",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);
			// If the user is not logged in send them to the login page.
			if (!agent) {
				return res.type("html").send(page(login({})));
			}

			console.log("req.body", req.body);

		//	const preferences = await agent.app.bsky.actor.getPreferences();
		//	const { items } = preferences.data.preferences[9] as SavedFeedsPrefV2;

		//	return res.type("html").send(page(feeds({ items })));
		}),
	);

	// Chat page
	router.get(
		"/chat",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);
			// If the user is not logged in send them to the login page.
			if (!agent) {
				return res.type("html").send(page(login({})));
			}
			return res.type("html").send(page(chat({})));
		}),
	);

	// Notifications page
	router.get(
		"/notifications",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);
			// If the user is not logged in send them to the login page.
			if (!agent) {
				return res.type("html").send(page(login({})));
			}
			return res.type("html").send(page(notifications({})));
		}),
	);

	// Search page
	router.get(
		"/search",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);
			// If the user is not logged in send them to the login page.
			if (!agent) {
				return res.type("html").send(page(login({})));
			}
			return res.type("html").send(page(search({})));
		}),
	);

	router.get(
		"/profile",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);
			// If the user is not logged in send them to the login page.
			if (!agent) {
				return res.type("html").send(page(login({})));
			}
			const id: string = agent.did ?? "";
			const { data } = await agent.getProfile({ actor: id });
			const {
				did,
				handle,
				displayName,
				avatar,
				banner,
				description,
				followersCount,
				followsCount,
				postsCount,
				createdAt,
				...rest
			} = data;

			// let's try getting my feed

			//https://docs.bsky.app/docs/tutorials/viewing-feeds#author-feeds
			const feed = await agent.getAuthorFeed({
				actor: id,
				filter: "posts_no_replies",
				limit: 50,
			});

			const { feed: postsArray, cursor: nextPage } = feed.data;

			return res.type("html").send(
				page(
					profile({
						handle,
						displayName,
						avatar,
						banner,
						description,
						followersCount,
						followsCount,
						postsCount,
						createdAt,
						postsArray,
					}),
				),
			);
		}),
	);

	return router;
};
