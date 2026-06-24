#!/usr/bin/env bash
set -euo pipefail

composer_home="${RUNNER_TEMP:-/tmp}/composer-home-legacy-shopware"
mkdir -p "$composer_home"
echo "COMPOSER_HOME=$composer_home" >> "$GITHUB_ENV"

cat > "$composer_home/config.json" <<'JSON'
{
  "repositories": {
    "shopware-conflicts-legacy-66": {
      "type": "package",
      "canonical": false,
      "package": {
        "name": "shopware/conflicts",
        "version": "6.6.x-dev",
        "type": "metapackage",
        "description": "Shopware 6 conflicting packages",
        "license": "MIT",
        "conflict": {
          "phenx/php-font-lib": "<0.5.5",
          "symfony/var-exporter": "v6.3.9 || v6.4.0",
          "symfony/notifier": "v5.3.8",
          "symfony/symfony": "*",
          "symfony/cache": "6.2.3 || 5.4.17",
          "symfony/messenger": "6.3.5",
          "zircote/swagger-php": "4.8.7",
          "symfony/phpunit-bridge": "6.4.8 || 7.0.8",
          "opensearch-project/opensearch-php": ">2.3.1",
          "shopware/k8s-meta": "<=1.0.3",
          "twig/twig": ">=3.21",
          "symfony/framework-bundle": ">=6.4.19 <7.0 || >=7.2.4"
        }
      }
    }
  }
}
JSON

echo "Registered shopware/conflicts 6.6.x-dev metapackage alias."
