-- ADS 榜单结果表 DML：从 DWD 榜单明细表取每种 sort_type 的最新 dt，全量覆盖写入
-- 说明：
--   * 每种 sort_type 只保留最新一期榜单（数据使用最新快照展示）
--   * INSERT OVERWRITE 全量覆盖，重复执行结果一致
--   * 列顺序与 dwd_github_trend_rank_f_1d 一致，r.* 直接对齐

INSERT OVERWRITE ads.ads_github_trend_rank_f
SELECT r.*
FROM dwd.dwd_github_trend_rank_f_1d r
JOIN (
    SELECT sort_type, MAX(dt) AS max_dt
    FROM dwd.dwd_github_trend_rank_f_1d
    GROUP BY sort_type
) m
  ON r.sort_type = m.sort_type
 AND r.dt = m.max_dt;
