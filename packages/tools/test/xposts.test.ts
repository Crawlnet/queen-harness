// What an X search's posts are worth showing (src/free/xposts.ts): every post twice, giveaways first. One of each, no
// spam, no other token's promo, the most liked first. Handles and texts made up here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cashtags, keepPosts } from "../src/free/xposts.ts";

const COLUMNS = ["handle", "followers", "text", "likes", "views"];
type Row = [string, number, string, number, number];
const twice = (rows: Row[]): Row[] => [...rows, ...rows];
const records = (rows: Row[]) => rows.map((r) => Object.fromEntries(COLUMNS.map((c, i) => [c, r[i]])));

const GIVEAWAYS: Row[] = [
  ["gift_acct_one", 12000, "GIVEAWAY 🎁 $500 in $WIF to 5 winners! Follow + RT and drop your SOL address below", 310, 40000],
  ["gift_acct_two", 8800, "First 100 people to reply with their $SOL address get 50 $WIF each, no joke", 220, 31000],
  ["gift_acct_three", 5400, "Drop wallets 👇 sending $WIF to everyone who does like & rt on this one", 180, 22000],
  ["gift_acct_four", 15000, "$WIF air drop is live, claim before it ends, link in bio", 150, 19000],
  ["gift_acct_five", 3000, "To enter: follow me, tag 3 friends, winner gets 1000 $WIF tomorrow", 90, 9000],
];
const TALK: Row[] = [
  ["perp_venue_x", 429669, "You can now long or short $WIF (dogwifhat) here with up to 3x leverage", 483, 91073],
  ["wif_holder_x", 41800, "Held dogwifhat since 2023, down 80% at one point, still here. $WIF taught me patience", 5500, 410000],
  ["short_call_x", 30172, "Shorting $WIF here, dogwifhat lost the 1.20 support on the daily, invalidation above 1.35", 226, 26953],
  ["recovery_x", 3932, "dogwifhat recovery looks real, volume back above the 30d average and funding flat", 422, 23950],
  ["cat_promo_x", 2100, "2024 was dogwifhat, 2026 is $OTHERCAT, othercat is the one to watch now", 300, 12000],
];

describe("the X search's posts: repeats, spam and other tokens' promos out", () => {
  it("the giveaway answer: each post once, every one spam (said how many), nothing left", () => {
    const k = keepPosts(records(twice(GIVEAWAYS)), ["WIF"]);
    assert.deepEqual(k.posts, []);
    assert.equal(k.spam, 5, "repeats are not counted as spam");
  });

  it("the real answer: each post once, the most liked first, a promo of another cashtag out when a ticker was asked", () => {
    const asked = keepPosts(records(twice(TALK)), ["WIF"]);
    assert.deepEqual(asked.posts.map((p) => p.handle), ["wif_holder_x", "perp_venue_x", "recovery_x", "short_call_x"]);
    assert.equal(asked.spam, 1);
    const none = keepPosts(records(twice(TALK)));
    assert.equal(none.posts.length, 5, "no ticker asked: no promo check");
    assert.equal(none.spam, 0);
  });

  it("spam by its words: wallet drops, reply asks, first N, follow and retweet, dm me, a draw's rules; never trade talk", () => {
    const spam = [
      "first 100 people to reply with their $SOL address",
      "drop wallets",
      "Drop ur addy below",
      "drop your sol address and I send",
      "reply with your solana wallet address",
      "Follow me and RT to win",
      "like & rt",
      "dm me for the presale",
      "To enter, follow and retweet",
      "Giveaway time",
      "$JUP airdrop checker is live",
    ];
    for (const text of spam) assert.equal(keepPosts([{ handle: "a", text }]).spam, 1, text);
    const fine = ["good time to enter $WIF on this dip?", "good time to enter, funding is negative on $WIF", "wallets dropped 12% of their bags this week", "$WIF funding flipped negative", "I dm'd the team, no answer yet"];
    for (const text of fine) assert.equal(keepPosts([{ handle: "a", text }], ["WIF"]).spam, 0, text);
  });

  it("on-chain talk is no spam: first N wallets or users, a drop beside whale wallets, a follow-through", () => {
    const fine = [
      "The first 20 wallets sniped 35% of $WIF supply at launch",
      "first 50 wallets still hold 60% of supply, careful with $WIF",
      "Binance's first 1000 users trading $WIF perps got fee rebates",
      "Since the drop whale wallets have added 5M $WIF",
      "price drop smart wallets are buying $WIF",
      "$WIF bulls: like, follow-through above 1.35 and the range breaks",
    ];
    for (const text of fine) assert.equal(keepPosts([{ handle: "a", text }], ["WIF"]).spam, 0, text);
  });

  it("the wallet asks a giveaway words otherwise are spam: comment, post, leave, reply or send your wallet; follow @x and RT", () => {
    const spam = ["Comment your SOL wallet below 👇", "Post your wallet address", "Leave your $SOL wallet", "reply your SOL address", "send me your wallet", "Follow @giveaway_acct and RT", "drop sol address below", "Drop wallets, sending to all"];
    for (const text of spam) assert.equal(keepPosts([{ handle: "a", text }], ["WIF"]).spam, 1, text);
  });

  it("a promo: other cashtags and not the asked one; the majors are no promo, a cashtag cut at the text's end is the asked one it begins", () => {
    const one = (text: string) => keepPosts([{ handle: "a", text }], ["WIF"]).spam;
    assert.equal(one("$BONKWIF is the next 100x, get in early"), 1);
    assert.equal(one("$WIF and $BONK both up 20% today"), 0, "it names the asked one too");
    assert.equal(one("dogwifhat outran $BTC and $ETH this week"), 0, "the majors are no promo");
    assert.equal(one("Dogwifhat turns 1 today. Very few memes reach billions in mcap, fewer pass the test of time $W"), 0, "a cut $WIF");
    assert.equal(one("WIF holders are fine, $POPCAT too"), 0, "the ticker as a word in capitals");
  });

  it("the asked project by its name from the query and by its exchange pairs; a promo's words beside another cashtag still go", () => {
    const named = (text: string) => keepPosts([{ handle: "a", text }], ["WIF"], ["dogwifhat"]).spam;
    assert.equal(named("dogwifhat just flipped $BONK by market cap again"), 0);
    assert.equal(named("dogwifhat vs $POPCAT, which cat/dog wins this cycle?"), 0);
    assert.equal(named("2024 was dogwifhat, 2026 is $OTHERCAT, othercat is the one to watch now"), 1, "named only to push another");
    assert.equal(named("Dogwifhat holders are rotating into $MOODENG, get in early"), 1);
    const pair = (text: string) => keepPosts([{ handle: "a", text }], ["WIF"]).spam;
    assert.equal(pair("$WIFUSDT perpetual contract now live with up to 50x leverage"), 0);
    assert.equal(pair("Long $WIFUSDT here, target 2.4, stop 1.9"), 0);
    assert.equal(pair("$WIFPERP and $BONKUSDT funding both negative"), 0);
    assert.equal(pair("$SOLUSDT bounced, $POPCATUSDT next"), 1, "a major's pair is no asked one");
    assert.equal(keepPosts([{ handle: "a", text: "dogwifhat vs $POPCAT, which cat/dog wins this cycle?" }], ["WIF"]).spam, 1, "no name from the query: another token's");
    assert.equal(keepPosts([{ handle: "a", text: "dog wif hat vs $POPCAT" }], ["WIF"], ['"dog wif hat"']).spam, 0, "a quoted name");
    assert.equal(named("dogwifhat, get in early before the listing $W"), 0, "the asked one's own promo, its cashtag cut: no other token's (the prompt bans it)");
  });

  it("posts by nested authors and metrics: one of each, ranked by likes then views", () => {
    const k = keepPosts([
      { id: "1", author: { username: "b" }, text: "two", public_metrics: { like_count: 5, impression_count: 10 } },
      { id: "2", author: { username: "a" }, text: "one", public_metrics: { like_count: 5, impression_count: 90 } },
      { id: "3", author: { username: "A" }, text: " one ", public_metrics: { like_count: 5 } },
      { id: "4", user: { screen_name: "c" }, full_text: "three", favorite_count: "1,200" },
    ]);
    assert.deepEqual(k.posts.map((p) => p.id), ["4", "2", "1"]);
  });

  it("cashtags: a letter first, never an amount", () => {
    assert.deepEqual(cashtags("dogwifhat OR $wif $20 $WIF"), ["WIF"]);
  });
});
