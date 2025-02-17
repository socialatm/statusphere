import express from "express";
import type { AppContext } from "#/index";
import { getSessionAgent, handler } from "#/lib/utils";
import { page } from "#/lib/view";
import { home } from "#/pages/home";
import { lists } from "#/pages/lists";
import { login } from "#/pages/login";

export const createListsRouter = (ctx: AppContext) => {
	const router = express.Router();

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

			// https://docs.bsky.app/docs/api/app-bsky-graph-get-lists
			const myLists = await agent.app.bsky.graph.getLists({
				actor: agent.assertDid,
				limit: 50,
			});
			const items = myLists.data.lists;

			return res.type("html").send(page(lists({ items })));
		}),
	);

	router.post(
		"/lists",
		handler(async (req, res) => {
			// If the user is signed in, get an agent which communicates with their server
			const agent = await getSessionAgent(req, res, ctx);
			// If the user is not logged in send them to the login page.
			if (!agent) {
				return res.type("html").send(page(login({})));
			}

			const feedName = req.body.name;
			const { data } = await agent.app.bsky.feed.getListFeed({
				list: req.body.uri,
				limit: 30,
			});

			const { feed: postsArray, cursor: nextPage } = data;
			// sort decending by createdAt
			postsArray.sort((a, b) =>
				(a.post.record as { createdAt: string }).createdAt >
				(b.post.record as { createdAt: string }).createdAt
					? -1
					: 1,
			);

			return res.type("html").send(page(home({ postsArray, feedName })));
		}),
	);

	return router;
};
