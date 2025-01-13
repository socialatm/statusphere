import express from 'express'
import { handler, getSessionAgent } from '#/lib/utils'
import { AppContext } from '#/index'
import { page } from "#/lib/view";
import { profile } from "#/pages/profile";
import { login } from '#/pages/login'

export const createProfileRouter = (ctx: AppContext) => {
  const router = express.Router()
  
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
  
        // profile page  
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

  return router
}