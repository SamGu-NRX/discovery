// X GraphQL responses for tests, built from the shapes twitter-web-exporter
// documents (src/types/index.ts and src/types/tweet.ts at ddf2b0c), stripped
// to the fields the parser reads plus a few it must ignore.

export function tweet({
  id,
  handle,
  userId,
  name = handle.toUpperCase(),
  text = `post ${id}`,
  created = "Sat Oct 25 13:28:50 +0000 2026",
  conversationId = id,
  inReplyTo,
  urls = [],
  media,
  note,
  noteUrls = [],
  quoted,
  retweeted,
  views = "2300",
}) {
  return {
    __typename: "Tweet",
    rest_id: id,
    core: { user_results: { result: { __typename: "User", rest_id: userId, core: { screen_name: handle, name } } } },
    views: { count: views, state: "EnabledWithCount" },
    ...(note && {
      note_tweet: {
        is_expandable: true,
        note_tweet_results: { result: { id: `note-${id}`, text: note, entity_set: { urls: noteUrls.map(entityUrl) } } },
      },
    }),
    ...(quoted && { quoted_status_result: { result: quoted } }),
    legacy: {
      bookmark_count: 9,
      created_at: created,
      conversation_id_str: conversationId,
      entities: { urls: urls.map(entityUrl), user_mentions: [], hashtags: [], symbols: [] },
      ...(media && { extended_entities: { media } }),
      favorite_count: 12,
      full_text: text,
      lang: "en",
      quote_count: 1,
      reply_count: 4,
      retweet_count: 3,
      user_id_str: userId,
      id_str: id,
      ...(inReplyTo && { in_reply_to_status_id_str: inReplyTo }),
      ...(quoted && { is_quote_status: true }),
      ...(retweeted && { retweeted_status_result: { result: retweeted } }),
    },
  };
}

function entityUrl(expanded) {
  return { url: "https://t.co/abc", expanded_url: expanded, display_url: expanded.replace(/^https?:\/\//, "") };
}

export function visibilityWrapped(inner) {
  return { __typename: "TweetWithVisibilityResults", limitedActionResults: { limited_actions: [] }, tweet: inner };
}

const tweetContent = (result) => ({
  itemType: "TimelineTweet",
  __typename: "TimelineTweet",
  tweet_results: result === undefined ? {} : { result },
  tweetDisplayType: "Tweet",
});

const idOf = (result) => result.rest_id ?? result.tweet?.rest_id;

export function itemEntry(result, sortIndex, entryId = `tweet-${idOf(result)}`) {
  return {
    entryId,
    sortIndex,
    content: { entryType: "TimelineTimelineItem", __typename: "TimelineTimelineItem", itemContent: tweetContent(result) },
  };
}

export function moduleEntry(entryId, sortIndex, results, { cursorItem = false } = {}) {
  const items = results.map((r) => ({ entryId: `${entryId}-tweet-${idOf(r)}`, item: { itemContent: tweetContent(r) } }));
  if (cursorItem) {
    items.push({
      entryId: `${entryId}-cursor-showmore-1`,
      item: { itemContent: { itemType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", value: "c", cursorType: "ShowMore" } },
    });
  }
  return {
    entryId,
    sortIndex,
    content: { entryType: "TimelineTimelineModule", __typename: "TimelineTimelineModule", displayType: "VerticalConversation", items },
  };
}

export function cursorEntry(direction, sortIndex) {
  return {
    entryId: `cursor-${direction}-${sortIndex}`,
    sortIndex,
    content: { entryType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", value: "DAABCgAB", cursorType: direction === "top" ? "Top" : "Bottom" },
  };
}

const PHOTO = {
  type: "photo",
  media_url_https: "https://pbs.twimg.com/media/F1aT_M9aAAEgJwi.jpg",
  id_str: "1",
  display_url: "pic.x.com/a",
  expanded_url: "https://x.com/alice/status/101/photo/1",
};

const VIDEO = {
  type: "video",
  media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg",
  id_str: "2",
  video_info: {
    variants: [
      { content_type: "application/x-mpegURL", url: "https://video.twimg.com/a.m3u8" },
      { bitrate: 256000, content_type: "video/mp4", url: "https://video.twimg.com/low.mp4" },
      { bitrate: 2176000, content_type: "video/mp4", url: "https://video.twimg.com/high.mp4" },
    ],
  },
};

export const NOTE_TEXT = `${"A long post that X stores as a note tweet. ".repeat(12)}The end.`;

// HomeTimeline: entries deliberately out of display order (sortIndex
// decides), with a promoted post, a who-to-follow module, a tombstone, a
// visibility-limited entry with no result, and top and bottom cursors.
export function homeResponse() {
  const entries = [
    itemEntry(
      tweet({ id: "106", handle: "dave", userId: "u-dave", text: "RT @erin: original text", retweeted: tweet({ id: "107", handle: "erin", userId: "u-erin", text: "original text" }) }),
      "1900",
    ),
    cursorEntry("top", "2100"),
    itemEntry(
      tweet({
        id: "101",
        handle: "alice",
        userId: "u-alice",
        name: "Alice A",
        text: "Tools &amp; tricks &lt;3 https://t.co/abc",
        urls: ["https://expanded.example/link"],
        media: [PHOTO],
        views: "2300",
      }),
      "2000",
    ),
    itemEntry(visibilityWrapped(tweet({ id: "102", handle: "bob", userId: "u-bob", text: "limited visibility post" })), "1990"),
    itemEntry(
      tweet({ id: "103", handle: "carol", userId: "u-carol", text: "A long post that X stores as a note… https://t.co/n", note: NOTE_TEXT, noteUrls: ["https://note.example/full"], media: [VIDEO] }),
      "1980",
    ),
    {
      entryId: "promoted-tweet-999-abc",
      sortIndex: "1975",
      content: {
        entryType: "TimelineTimelineItem",
        itemContent: { ...tweetContent(tweet({ id: "999", handle: "brand", userId: "u-brand" })), promotedMetadata: { advertiser_results: {} } },
      },
    },
    moduleEntry("home-conversation-104", "1970", [
      tweet({ id: "104", handle: "bob", userId: "u-bob", text: "question" }),
      tweet({ id: "105", handle: "carol", userId: "u-carol", text: "answer", conversationId: "104", inReplyTo: "104" }),
    ]),
    {
      entryId: "who-to-follow-1",
      sortIndex: "1960",
      content: {
        entryType: "TimelineTimelineModule",
        items: [{ entryId: "who-to-follow-1-user-5", item: { itemContent: { itemType: "TimelineUser", __typename: "TimelineUser", user_results: {} } } }],
      },
    },
    itemEntry({ __typename: "TweetTombstone", tombstone: { text: { text: "This Post was deleted by the Post author." } } }, "1950", "tweet-555"),
    itemEntry(undefined, "1940", "tweet-556"),
    itemEntry(
      tweet({ id: "108", handle: "frank", userId: "u-frank", text: "look at this", quoted: tweet({ id: "109", handle: "gina", userId: "u-gina", text: "quoted" }) }),
      "1800",
    ),
    cursorEntry("bottom", "1700"),
  ];
  return {
    data: {
      home: {
        home_timeline_urt: {
          instructions: [{ type: "TimelineClearCache" }, { type: "TimelineAddEntries", entries }],
          metadata: {},
        },
      },
    },
  };
}

export function bookmarksResponse(ids = ["401", "402"]) {
  const entries = ids.map((id, i) =>
    itemEntry(
      tweet({
        id,
        handle: "saver",
        userId: "u-saver",
        text: `saved ${id}`,
        quoted: i === 0 ? tweet({ id: `${id}9`, handle: "quoted", userId: "u-q" }) : undefined,
      }),
      String(5000 - i),
    ),
  );
  return { data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [...entries, cursorEntry("bottom", "1")] }] } } } };
}

// Permalink for 200 by "op". Thread shape:
//   200 op (focal)
//   ├ 201 op -> 200 ─ 202 op -> 201     self-thread, one module
//   ├ 203 x  -> 200 ─ 204 op -> 203     op answering someone: a reply
//   ├ 205 y  -> 202                     reply to a self-thread post
//   └ 206 z, 210 op, 209 q              "Discover more", in that order: not part of the
//                                       thread, even 210 by op (it replies to nothing here)
const op = (id, inReplyTo) => tweet({ id, handle: "op", userId: "u-op", conversationId: "200", inReplyTo, text: `op ${id}` });
const other = (id, handle, inReplyTo) => tweet({ id, handle, userId: `u-${handle}`, conversationId: "200", inReplyTo, text: `${handle} ${id}` });

export function detailResponse() {
  return detail([
    {
      type: "TimelineAddEntries",
      entries: [
        itemEntry(op("200"), "9000"),
        moduleEntry("conversationthread-201", "8990", [op("201", "200"), op("202", "201")], { cursorItem: true }),
        moduleEntry("conversationthread-203", "8980", [other("203", "x", "200"), op("204", "203")]),
        moduleEntry("conversationthread-205", "8970", [other("205", "y", "202")]),
        moduleEntry("tweetdetailrelatedtweets-1", "8960", [
          tweet({ id: "206", handle: "z", userId: "u-z" }),
          tweet({ id: "210", handle: "op", userId: "u-op", text: "op 210, another post" }),
          tweet({ id: "209", handle: "q", userId: "u-q" }),
        ]),
        cursorEntry("bottom", "8950"),
      ],
    },
    { type: "TimelineTerminateTimeline", direction: "Top" },
  ]);
}

// The next page of the same permalink: "show more" inside the self-thread
// module, and a further conversation module.
export function detailPage2Response() {
  return detail([
    {
      type: "TimelineAddToModule",
      moduleEntryId: "conversationthread-201",
      prepend: false,
      moduleItems: [{ entryId: "conversationthread-201-tweet-207", item: { itemContent: tweetContent(op("207", "202")) } }],
    },
    { type: "TimelineAddEntries", entries: [moduleEntry("conversationthread-208", "8940", [other("208", "w", "200")])] },
  ]);
}

// Permalink for 302, the third post of op's thread 300 -> 301 -> 302, where
// 300 itself replies to 299 by someone else.
export function midThreadDetailResponse() {
  const p = (id, inReplyTo) => tweet({ id, handle: "op", userId: "u-op", conversationId: "299", inReplyTo, text: `op ${id}` });
  return detail([
    {
      type: "TimelineAddEntries",
      entries: [
        itemEntry(tweet({ id: "299", handle: "x", userId: "u-x", conversationId: "299" }), "7000"),
        itemEntry(p("300", "299"), "6990"),
        itemEntry(p("301", "300"), "6980"),
        itemEntry(p("302", "301"), "6970"),
        moduleEntry("conversationthread-303", "6960", [p("303", "302"), other("304", "v", "302")]),
      ],
    },
  ]);
}

function detail(instructions) {
  return { data: { threaded_conversation_with_injections_v2: { instructions } } };
}

export function detailUrl(focalId) {
  const variables = encodeURIComponent(JSON.stringify({ focalTweetId: focalId, with_rux_injections: false }));
  return `https://x.com/i/api/graphql/abc123/TweetDetail?variables=${variables}`;
}

export const HOME_URL = "https://x.com/i/api/graphql/def456/HomeTimeline?variables=%7B%7D";
export const BOOKMARKS_URL = "https://x.com/i/api/graphql/ghi789/Bookmarks?variables=%7B%7D";
