/** クライアントへ公開してよい失敗だけを定義する API エラー。 */
export class ApiError extends Error {
  /** HTTP 状態と安定した機械可読コードを保持する。 */
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
