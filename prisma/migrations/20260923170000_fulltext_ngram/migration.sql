-- Signal: contents 的 FULLTEXT 索引改用 ngram parser
--
-- 背景（严重缺陷修复）：
--   初始迁移建的 `contents_title_summary_body_translated_idx` 使用 MySQL **默认**
--   fulltext parser。默认 parser 按非字母数字边界切词，中文没有空格，
--   于是「基础模型的能力评测与推理成本」整句变成一个 token —— 任何中文子串
--   都查不到。实测 `AGAINST('模型')` / `AGAINST('推理成本')` 均返回 0 行，
--   而 `LIKE '%模型%'` 能命中，证明数据在库、是索引不可用。
--
--   Signal 的主语言是中文（docs/12 要求的 bodyTranslated 就是中文译文），
--   默认 parser 会让 V1 搜索对中文**完全失效**。
--
-- 修复：
--   重建为 `WITH PARSER ngram`。ngram parser 按固定长度（ngram_token_size，
--   MySQL 默认 2）切分 CJK，中文子串查询即可命中。
--   实测修复后 `模型` / `推理成本` / `能力评测` 均正确命中。
--
-- 说明：
--   Prisma 的 `@@fulltext` 无法表达 parser 选项，因此该属性只能写在迁移 SQL 里。
--   已用 `prisma migrate diff --from-migrations --to-schema-datamodel` 验证
--   该属性不会造成 schema 漂移（Prisma 不比对 parser）。

-- DropIndex
DROP INDEX `contents_title_summary_body_translated_idx` ON `contents`;

-- CreateIndex
ALTER TABLE `contents`
  ADD FULLTEXT INDEX `contents_title_summary_body_translated_idx` (`title`, `summary`, `body_translated`)
  WITH PARSER ngram;
