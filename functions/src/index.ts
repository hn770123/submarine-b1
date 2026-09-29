/** 第二世代 HTTP 関数のエントリーポイント。権威データへの接続は Admin SDK のみ。 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { createApp } from "./app.js";
import { RoomRepository } from "./repository.js";
initializeApp();
export const api = onRequest(
  {
    region: "asia-northeast1",
    timeoutSeconds: 30,
    concurrency: 40,
    minInstances: 0,
    maxInstances: 4,
  },
  createApp(new RoomRepository(getFirestore())),
);
