import is from '@sindresorhus/is';
import { mergeChildConfig } from '../../../../config';
import type { ValidationMessage } from '../../../../config/types';
import { CONFIG_VALIDATION } from '../../../../constants/error-messages';
import { logger } from '../../../../logger';
import {
  Release,
  ReleaseResult,
  applyDatasourceFilters,
  getDigest,
  getRawPkgReleases,
  isGetPkgReleasesConfig,
  supportsDigests,
} from '../../../../modules/datasource';
import {
  getDatasourceFor,
  getDefaultVersioning,
} from '../../../../modules/datasource/common';
import { getRangeStrategy } from '../../../../modules/manager';
import * as allVersioning from '../../../../modules/versioning';
import { ExternalHostError } from '../../../../types/errors/external-host-error';
import { assignKeys } from '../../../../util/assign-keys';
import { applyPackageRules } from '../../../../util/package-rules';
import { regEx } from '../../../../util/regex';
import { getBucket } from './bucket';
import { getCurrentVersion } from './current';
import { filterVersions } from './filter';
import { filterInternalChecks } from './filter-checks';
import { generateUpdate } from './generate';
import { getRollbackUpdate } from './rollback';
import type { LookupUpdateConfig, UpdateResult } from './types';
import {
  addReplacementUpdateIfValid,
  isReplacementRulesConfigured,
} from './utils';

export async function lookupUpdates(
  inconfig: LookupUpdateConfig
): Promise<UpdateResult> {
  let config: LookupUpdateConfig = { ...inconfig };
  config.versioning ??= getDefaultVersioning(config.datasource);

  const versioning = allVersioning.get(config.versioning);
  const unconstrainedValue =
    !!config.lockedVersion && is.undefined(config.currentValue);

  let dependency: ReleaseResult | null = null;
  const res: UpdateResult = {
    versioning: config.versioning,
    updates: [],
    warnings: [],
  };

  try {
    logger.trace(
      {
        dependency: config.packageName,
        currentValue: config.currentValue,
      },
      'lookupUpdates'
    );
    // istanbul ignore if
    if (
      !isGetPkgReleasesConfig(config) ||
      !getDatasourceFor(config.datasource)
    ) {
      res.skipReason = 'invalid-config';
      return res;
    }
    const isValid =
      is.string(config.currentValue) && versioning.isValid(config.currentValue);

    if (unconstrainedValue || isValid) {
      if (
        !config.updatePinnedDependencies &&
        // TODO #22198
        versioning.isSingleVersion(config.currentValue!)
      ) {
        res.skipReason = 'is-pinned';
        return res;
      }

      const { val: releaseResult, err: lookupError } = await getRawPkgReleases(
        config
      )
        .transform((res) => applyDatasourceFilters(res, config))
        .unwrap();

      if (lookupError instanceof Error) {
        throw lookupError;
      }

      if (lookupError) {
        // If dependency lookup fails then warn and return
        const warning: ValidationMessage = {
          topic: config.packageName,
          message: `Failed to look up ${config.datasource} package ${config.packageName}`,
        };
        logger.debug(
          {
            dependency: config.packageName,
            packageFile: config.packageFile,
          },
          warning.message
        );
        // TODO: return warnings in own field
        res.warnings.push(warning);
        return res;
      }

      dependency = releaseResult;

      if (dependency.deprecationMessage) {
        logger.debug(
          `Found deprecationMessage for ${config.datasource} package ${config.packageName}`
        );
      }

      assignKeys(res, dependency, [
        'deprecationMessage',
        'sourceUrl',
        'registryUrl',
        'sourceDirectory',
        'homepage',
        'changelogUrl',
        'dependencyUrl',
      ]);

      const latestVersion = dependency.tags?.latest;
      // Filter out any results from datasource that don't comply with our versioning
      let allVersions = dependency.releases.filter((release) =>
        versioning.isVersion(release.version)
      );

      // istanbul ignore if
      if (allVersions.length === 0) {
        const message = `Found no results from datasource that look like a version`;
        logger.debug(
          {
            dependency: config.packageName,
            result: dependency,
          },
          message
        );
        if (!config.currentDigest) {
          return res;
        }
      }
      // Reapply package rules in case we missed something from sourceUrl
      config = applyPackageRules({ ...config, sourceUrl: res.sourceUrl });
      if (config.followTag) {
        const taggedVersion = dependency.tags?.[config.followTag];
        if (!taggedVersion) {
          res.warnings.push({
            topic: config.packageName,
            message: `Can't find version with tag ${config.followTag} for ${config.datasource} package ${config.packageName}`,
          });
          return res;
        }
        allVersions = allVersions.filter(
          (v) =>
            v.version === taggedVersion ||
            (v.version === config.currentValue &&
              versioning.isGreaterThan(taggedVersion, config.currentValue))
        );
      }
      // Check that existing constraint can be satisfied
      const allSatisfyingVersions = allVersions.filter(
        (v) =>
          // TODO #22198
          unconstrainedValue ||
          versioning.matches(v.version, config.currentValue!)
      );
      if (!allSatisfyingVersions.length) {
        logger.debug(
          `Found no satisfying versions with '${config.versioning}' versioning`
        );
      }

      if (config.rollbackPrs && !allSatisfyingVersions.length) {
        const rollback = getRollbackUpdate(config, allVersions, versioning);
        // istanbul ignore if
        if (!rollback) {
          res.warnings.push({
            topic: config.packageName,
            // TODO: types (#22198)
            message: `Can't find version matching ${config.currentValue!} for ${
              config.datasource
            } package ${config.packageName}`,
          });
          return res;
        }
        res.updates.push(rollback);
      }
      let rangeStrategy = getRangeStrategy(config);

      // istanbul ignore next
      if (
        config.isVulnerabilityAlert &&
        rangeStrategy === 'update-lockfile' &&
        !config.lockedVersion
      ) {
        rangeStrategy = 'bump';
      }
      const nonDeprecatedVersions = dependency.releases
        .filter((release) => !release.isDeprecated)
        .map((release) => release.version);
      let currentVersion: string;
      if (rangeStrategy === 'update-lockfile') {
        currentVersion = config.lockedVersion!;
      }
      // TODO #22198
      currentVersion ??=
        getCurrentVersion(
          config.currentValue!,
          config.lockedVersion!,
          versioning,
          rangeStrategy!,
          latestVersion!,
          nonDeprecatedVersions
        ) ??
        getCurrentVersion(
          config.currentValue!,
          config.lockedVersion!,
          versioning,
          rangeStrategy!,
          latestVersion!,
          allVersions.map((v) => v.version)
        )!;
      // istanbul ignore if
      if (!currentVersion! && config.lockedVersion) {
        return res;
      }
      res.currentVersion = currentVersion!;
      if (
        config.currentValue &&
        currentVersion &&
        rangeStrategy === 'pin' &&
        !versioning.isSingleVersion(config.currentValue)
      ) {
        res.updates.push({
          updateType: 'pin',
          isPin: true,
          // TODO: newValue can be null! (#22198)
          newValue: versioning.getNewValue({
            currentValue: config.currentValue,
            rangeStrategy,
            currentVersion,
            newVersion: currentVersion,
          })!,
          newVersion: currentVersion,
          newMajor: versioning.getMajor(currentVersion)!,
        });
      }
      if (rangeStrategy === 'pin') {
        // Fall back to replace once pinning logic is done
        rangeStrategy = 'replace';
      }
      // istanbul ignore if
      if (!versioning.isVersion(currentVersion!)) {
        res.skipReason = 'invalid-version';
        return res;
      }
      // Filter latest, unstable, etc
      // TODO #22198
      let filteredReleases = filterVersions(
        config,
        currentVersion!,
        latestVersion!,
        config.rangeStrategy === 'in-range-only'
          ? allSatisfyingVersions
          : allVersions,
        versioning
      ).filter(
        (v) =>
          // Leave only compatible versions
          unconstrainedValue ||
          versioning.isCompatible(v.version, config.currentValue)
      );
      if (config.isVulnerabilityAlert && !config.osvVulnerabilityAlerts) {
        filteredReleases = filteredReleases.slice(0, 1);
      }
      const buckets: Record<string, [Release]> = {};
      for (const release of filteredReleases) {
        const bucket = getBucket(
          config,
          // TODO #22198
          currentVersion!,
          release.version,
          versioning
        );
        if (is.string(bucket)) {
          if (buckets[bucket]) {
            buckets[bucket].push(release);
          } else {
            buckets[bucket] = [release];
          }
        }
      }
      const depResultConfig = mergeChildConfig(config, res);
      for (const [bucket, releases] of Object.entries(buckets)) {
        const sortedReleases = releases.sort((r1, r2) =>
          versioning.sortVersions(r1.version, r2.version)
        );
        const { release, pendingChecks, pendingReleases } =
          await filterInternalChecks(
            depResultConfig,
            versioning,
            bucket,
            sortedReleases
          );
        // istanbul ignore next
        if (!release) {
          return res;
        }
        const newVersion = release.version;
        const update = await generateUpdate(
          config,
          versioning,
          // TODO #22198

          rangeStrategy!,
          config.lockedVersion ?? currentVersion!,
          bucket,
          release
        );
        if (pendingChecks) {
          update.pendingChecks = pendingChecks;
        }

        // TODO #22198
        if (pendingReleases!.length) {
          update.pendingVersions = pendingReleases!.map((r) => r.version);
        }
        if (!update.newValue || update.newValue === config.currentValue) {
          if (!config.lockedVersion) {
            continue;
          }
          // istanbul ignore if
          if (rangeStrategy === 'bump') {
            logger.trace(
              {
                packageName: config.packageName,
                currentValue: config.currentValue,
                lockedVersion: config.lockedVersion,
                newVersion,
              },
              'Skipping bump because newValue is the same'
            );
            continue;
          }
          res.isSingleVersion = true;
        }
        res.isSingleVersion =
          !!res.isSingleVersion ||
          !!versioning.isSingleVersion(update.newValue);

        res.updates.push(update);
      }
    } else if (config.currentValue) {
      logger.debug(
        `Dependency ${config.packageName} has unsupported/unversioned value ${config.currentValue} (versioning=${config.versioning})`
      );

      if (!config.pinDigests && !config.currentDigest) {
        res.skipReason = 'invalid-value';
      } else {
        delete res.skipReason;
      }
    } else {
      res.skipReason = 'invalid-value';
    }

    if (isReplacementRulesConfigured(config)) {
      addReplacementUpdateIfValid(res.updates, config);
    }

    // Record if the dep is fixed to a version
    if (config.lockedVersion) {
      res.currentVersion = config.lockedVersion;
      res.fixedVersion = config.lockedVersion;
    } else if (
      config.currentValue &&
      versioning.isSingleVersion(config.currentValue)
    ) {
      res.fixedVersion = config.currentValue.replace(regEx(/^=+/), '');
    }
    // Add digests if necessary
    if (supportsDigests(config.datasource)) {
      if (config.currentDigest) {
        if (!config.digestOneAndOnly || !res.updates.length) {
          // digest update
          res.updates.push({
            updateType: 'digest',
            // TODO #22198
            newValue: config.currentValue!,
          });
        }
      } else if (config.pinDigests) {
        // Create a pin only if one doesn't already exists
        if (!res.updates.some((update) => update.updateType === 'pin')) {
          // pin digest
          res.updates.push({
            isPinDigest: true,
            updateType: 'pinDigest',
            // TODO #22198
            newValue: config.currentValue!,
          });
        }
      }
      if (versioning.valueToVersion) {
        // TODO #22198
        res.currentVersion = versioning.valueToVersion(res.currentVersion!);
        for (const update of res.updates || /* istanbul ignore next*/ []) {
          // TODO #22198
          update.newVersion = versioning.valueToVersion(update.newVersion!);
        }
      }
      if (res.registryUrl) {
        config.registryUrls = [res.registryUrl];
      }

      // update digest for all
      for (const update of res.updates) {
        if (config.pinDigests === true || config.currentDigest) {
          // TODO #22198
          update.newDigest ??=
            dependency?.releases.find((r) => r.version === update.newValue)
              ?.newDigest ?? (await getDigest(config, update.newValue))!;

          // If the digest could not be determined, report this as otherwise the
          // update will be omitted later on without notice.
          if (update.newDigest === null) {
            logger.debug(
              {
                packageName: config.packageName,
                currentValue: config.currentValue,
                datasource: config.datasource,
                newValue: update.newValue,
                bucket: update.bucket,
              },
              'Could not determine new digest for update.'
            );

            // Only report a warning if there is a current digest.
            // Context: https://github.com/renovatebot/renovate/pull/20175#discussion_r1102615059.
            if (config.currentDigest) {
              res.warnings.push({
                message: `Could not determine new digest for update (datasource: ${config.datasource})`,
                topic: config.packageName,
              });
            }
          }
        } else {
          delete update.newDigest;
        }
        if (update.newVersion) {
          const registryUrl = dependency?.releases?.find(
            (release) => release.version === update.newVersion
          )?.registryUrl;
          if (registryUrl && registryUrl !== res.registryUrl) {
            update.registryUrl = registryUrl;
          }
        }
      }
    }
    if (res.updates.length) {
      delete res.skipReason;
    }
    // Strip out any non-changed ones
    res.updates = res.updates
      .filter(
        (update) => update.newValue !== null || config.currentValue === null
      )
      .filter((update) => update.newDigest !== null)
      .filter(
        (update) =>
          (is.string(update.newName) &&
            update.newName !== config.packageName) ||
          update.isReplacement === true ||
          update.newValue !== config.currentValue ||
          update.isLockfileUpdate === true ||
          // TODO #22198
          (update.newDigest &&
            !update.newDigest.startsWith(config.currentDigest!))
      );
    // If range strategy specified in config is 'in-range-only', also strip out updates where currentValue !== newValue
    if (config.rangeStrategy === 'in-range-only') {
      res.updates = res.updates.filter(
        (update) => update.newValue === config.currentValue
      );
    }
    // Handle a weird edge case involving followTag and fallbacks
    if (config.rollbackPrs && config.followTag) {
      res.updates = res.updates.filter(
        (update) =>
          res.updates.length === 1 ||
          /* istanbul ignore next */ update.updateType !== 'rollback'
      );
    }
  } catch (err) /* istanbul ignore next */ {
    if (err instanceof ExternalHostError || err.message === CONFIG_VALIDATION) {
      throw err;
    }
    logger.error(
      {
        currentDigest: config.currentDigest,
        currentValue: config.currentValue,
        datasource: config.datasource,
        packageName: config.packageName,
        digestOneAndOnly: config.digestOneAndOnly,
        followTag: config.followTag,
        lockedVersion: config.lockedVersion,
        packageFile: config.packageFile,
        pinDigests: config.pinDigests,
        rollbackPrs: config.rollbackPrs,
        isVulnerabilityAlert: config.isVulnerabilityAlert,
        updatePinnedDependencies: config.updatePinnedDependencies,
        unconstrainedValue,
        err,
      },
      'lookupUpdates error'
    );
    res.skipReason = 'internal-error';
  }
  return res;
}
