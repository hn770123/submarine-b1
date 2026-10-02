/** 二つの独立ブラウザで参加・配置・行動・復帰と三人目の拒否を確認する。 */
import { test, expect } from "@playwright/test";
test("作成・参加・復帰・満員・360px 表示", async ({ browser }) => {
  const hostContext = await browser.newContext({
      viewport: { width: 360, height: 800 },
      reducedMotion: "reduce",
    }),
    guestContext = await browser.newContext({
      viewport: { width: 360, height: 800 },
    });
  const host = await hostContext.newPage(),
    guest = await guestContext.newPage();
  await host.goto("/");
  await host.getByLabel("表示名", { exact: true }).fill("ホスト");
  await host.getByLabel("表示名", { exact: true }).press("Tab");
  await expect(host.getByLabel("パスコード", { exact: true })).toBeFocused();
  await host.getByLabel("パスコード", { exact: true }).fill("secret12");
  await host.getByLabel("パスコード", { exact: true }).press("Enter");
  const code = await host.locator(".code").innerText();
  await expect(
    host.getByRole("heading", { name: "相手の参加を待っています" }),
  ).toBeVisible();
  await host.screenshot({
    path: "test-results/room-waiting-360.png",
    fullPage: true,
  });
  await guest.goto("/");
  await guest
    .getByRole("button", { name: "ルームに参加", exact: true })
    .click();
  await guest.getByLabel("表示名", { exact: true }).fill("ゲスト");
  await guest.getByLabel("ルームコード", { exact: true }).fill(code);
  await guest.getByLabel("パスコード", { exact: true }).fill("secret12");
  await guest.getByRole("button", { name: "参加する", exact: true }).click();
  await expect(guest.getByRole("heading", { name: "初期配置" })).toBeVisible();
  await expect(host.getByRole("heading", { name: "初期配置" })).toBeVisible();
  await guest.reload();
  await expect(guest.locator(".players")).toContainText("ゲスト（あなた）");
  await host.reload();
  await expect(host.locator(".players")).toContainText("ホスト（あなた）");
  const thirdContext = await browser.newContext();
  const third = await thirdContext.newPage();
  await third.goto("/");
  await third
    .getByRole("button", { name: "ルームに参加", exact: true })
    .click();
  await third.getByLabel("表示名", { exact: true }).fill("三人目");
  await third.getByLabel("ルームコード", { exact: true }).fill(code);
  await third.getByLabel("パスコード", { exact: true }).fill("secret12");
  await third.getByRole("button", { name: "参加する", exact: true }).click();
  await expect(third.getByRole("alert")).toHaveText("このルームは満員です。");
  expect(
    await host.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await host.screenshot({
    path: "test-results/room-ready-360.png",
    fullPage: true,
  });
  await host.setViewportSize({ width: 1280, height: 900 });
  await host.screenshot({
    path: "test-results/room-ready-desktop.png",
    fullPage: true,
  });
  // 別々のブラウザで配置を確定し、先手が一行動した後も再読み込みで復帰できる。
  await host.getByRole("button", { name: "配置を確定" }).click();
  await guest.getByRole("button", { name: "配置を確定" }).click();
  await expect(host.getByRole("heading", { name: "対戦中" })).toBeVisible();
  await expect(guest.getByRole("heading", { name: "対戦中" })).toBeVisible();
  await expect(
    guest.getByRole("img", { name: /戦術盤 12列 15行/ }),
  ).toBeVisible();
  const first = (await host.getByText("あなたの手番").count()) ? host : guest;
  await first.getByRole("button", { name: "左旋回" }).focus();
  await first.keyboard.press("Enter");
  await expect(
    first.getByRole("heading", { name: "左旋回を実行しますか？" }),
  ).toBeVisible();
  await expect(first.getByRole("button", { name: "実行する" })).toBeFocused();
  await first.keyboard.press("Escape");
  await expect(first.getByRole("button", { name: "左旋回" })).toBeFocused();
  await first.keyboard.press("Enter");
  await first.getByRole("button", { name: "実行する" }).click();
  await expect(first.getByText("第1手：左旋回")).toBeVisible();
  await expect(first.locator(".turn-banner")).toBeFocused();
  await first.setViewportSize({ width: 360, height: 800 });
  await first.evaluate(() => scrollTo(0, 0));
  await expect(first.locator(".board")).toBeInViewport({ ratio: 1 });
  expect(
    await first.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await first.screenshot({ path: "test-results/game-360.png", fullPage: true });
  await first.setViewportSize({ width: 1280, height: 900 });
  expect(
    await first.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await first.screenshot({
    path: "test-results/game-desktop.png",
    fullPage: true,
  });
  await first.reload();
  await expect(first.getByText("第1手：左旋回")).toBeVisible();
  await hostContext.close();
  await guestContext.close();
  await thirdContext.close();
});

test("二人の対戦が決着し、それぞれの結果画面へ復帰できる", async ({
  browser,
  request,
}) => {
  /** API の確定結果を使い、魚雷が盤上を進む長い対戦を再現する。 */
  async function post(path: string, body: object, token?: string) {
    const response = await request.post(`/api/v1${path}`, {
      data: body,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  let host, guest;
  let lane = -1;
  // ランダムな岩礁盤でも魚雷が通れる列を選び、結果画面の検証を安定させる。
  for (let attempt = 0; attempt < 5; attempt++) {
    host = await post("/rooms", {
      displayName: "ホスト",
      passcode: "secret12",
    });
    guest = await post(`/rooms/${host.roomCode}/join`, {
      displayName: "ゲスト",
      passcode: "secret12",
    });
    const reefs = new Set(
      guest.view.board.reefs.map(
        (p: { x: number; y: number }) => `${p.x},${p.y}`,
      ),
    );
    lane =
      Array.from({ length: guest.view.board.width }, (_, x) => x).find((x) =>
        Array.from({ length: 9 }, (_, y) => y + 3).every(
          (y) => !reefs.has(`${x},${y}`),
        ),
      ) ?? -1;
    if (lane >= 0) break;
  }
  expect(lane).toBeGreaterThanOrEqual(0);
  const path = `/rooms/${host.roomCode}`;
  await post(
    `${path}/placement`,
    { x: lane, y: 2, direction: "S" },
    host.token,
  );
  let state = await post(
    `${path}/placement`,
    { x: lane, y: 12, direction: "N" },
    guest.token,
  );
  const shooter = state.game.yourTurn ? guest : host;
  const target = shooter === host ? guest : host;
  let shots = 0;
  for (let i = 0; i < 30 && state.status === "playing"; i++) {
    // 手番の本人ビューを毎回取得し、サーバーが決めた先手に依存しない。
    const shooterStateResponse = await request.get(`/api/v1${path}/state`, {
      headers: { Authorization: `Bearer ${shooter.token}` },
    });
    const shooterState = await shooterStateResponse.json();
    const current = shooterState.game.yourTurn ? shooter : target;
    const action =
      current === shooter
        ? shots++ < 2
          ? "FIRE_TORPEDO"
          : "ACTIVE_SONAR"
        : "TURN_LEFT";
    state = await post(
      `${path}/actions`,
      { actionId: crypto.randomUUID(), expectedVersion: state.version, action },
      current.token,
    );
  }
  expect(state.status).toBe("finished");
  for (const [player, result, width] of [
    [shooter, "勝利", 360],
    [target, "敗北", 1280],
  ] as const) {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.evaluate(
      (session) =>
        sessionStorage.setItem("submarine-session-v1", JSON.stringify(session)),
      { roomCode: host.roomCode, token: player.token },
    );
    await page.reload();
    await expect(page.getByRole("heading", { name: "対戦終了" })).toBeVisible();
    await expect(page.getByText(result, { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: "行動履歴" })).toBeVisible();
    await expect(page.getByRole("img", { name: /戦術盤/ })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/result-${width}.png`,
      fullPage: true,
    });
    await context.close();
  }
});
