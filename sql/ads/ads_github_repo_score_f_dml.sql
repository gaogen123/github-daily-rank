-- ADS 仓库评分结果 DML：从 DWS 评分表取最新一期，全量覆盖
-- 列顺序与 dws_github_repo_score_f_1d 一致，r.* 直接对齐

INSERT OVERWRITE ads.ads_github_repo_score_f
SELECT r.*
FROM dws.dws_github_repo_score_f_1d r
WHERE r.dt = (SELECT MAX(dt) FROM dws.dws_github_repo_score_f_1d);
