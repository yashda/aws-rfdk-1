import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import { LICENSE, NOTICE } from './licensing';
import { PackageJson, ValidationRule } from './packagejson';
import {
  deepGet, deepSet,
  expectDevDependency, expectJSON,
  fileShouldBe, fileShouldContain,
  fileShouldNotContain,
  findInnerPackages,
  monoRepoRoot,
} from './util';

const AWS_SERVICE_NAMES = require('./aws-service-official-names.json'); // eslint-disable-line @typescript-eslint/no-require-imports

/**
 * Verify that the package name matches the directory name
 */
export class PackageNameMatchesDirectoryName extends ValidationRule {
  public readonly name = 'naming/package-matches-directory';

  public validate(pkg: PackageJson): void {
    const parts = pkg.packageRoot.split(path.sep);

    const expectedName = parts[parts.length - 2].startsWith('@')
      ? parts.slice(parts.length - 2).join('/')
      : parts[parts.length - 1];

    expectJSON(this.name, pkg, 'name', expectedName);
  }
}

/**
 * Verify that all packages have a description
 */
export class DescriptionIsRequired extends ValidationRule {
  public readonly name = 'package-info/require-description';

  public validate(pkg: PackageJson): void {
    if (!pkg.json.description) {
      pkg.report({ ruleName: this.name, message: 'Description is required' });
    }
  }
}

/**
 * Verify cdk.out directory is included in npmignore since we should not be
 * publishing it.
 */
export class CdkOutMustBeNpmIgnored extends ValidationRule {

  public readonly name = 'package-info/npm-ignore-cdk-out';

  public validate(pkg: PackageJson): void {

    const npmIgnorePath = path.join(pkg.packageRoot, '.npmignore');

    if (fs.existsSync(npmIgnorePath)) {

      const npmIgnore = fs.readFileSync(npmIgnorePath);

      if (!npmIgnore.includes('**/cdk.out')) {
        pkg.report({
          ruleName: this.name,
          message: `${npmIgnorePath}: Must exclude **/cdk.out`,
          fix: () => fs.writeFileSync(
            npmIgnorePath,
            `${npmIgnore}\n# exclude cdk artifacts\n**/cdk.out`,
          ),
        });
      }
    }
  }

}

/**
 * Repository must be our GitHub repo
 */
export class RepositoryCorrect extends ValidationRule {
  public readonly name = 'package-info/repository';

  public validate(pkg: PackageJson): void {
    expectJSON(this.name, pkg, 'repository.type', 'git');
    expectJSON(this.name, pkg, 'repository.url', 'https://github.com/aws/aws-rfdk.git');
    const pkgDir = path.relative(monoRepoRoot(), pkg.packageRoot);
    expectJSON(this.name, pkg, 'repository.directory', pkgDir);
  }
}

/**
 * Homepage must point to the GitHub repository page.
 */
export class HomepageCorrect extends ValidationRule {
  public readonly name = 'package-info/homepage';

  public validate(pkg: PackageJson): void {
    expectJSON(this.name, pkg, 'homepage', 'https://github.com/aws/aws-cdk');
  }
}

/**
 * The license must be Apache-2.0.
 */
export class License extends ValidationRule {
  public readonly name = 'package-info/license';

  public validate(pkg: PackageJson): void {
    expectJSON(this.name, pkg, 'license', 'Apache-2.0');
  }
}

/**
 * There must be a license file that corresponds to the Apache-2.0 license.
 */
export class LicenseFile extends ValidationRule {
  public readonly name = 'license/license-file';

  public validate(pkg: PackageJson): void {
    fileShouldBe(this.name, pkg, 'LICENSE', LICENSE);
  }
}

/**
 * There must be a NOTICE file.
 */
export class NoticeFile extends ValidationRule {
  public readonly name = 'license/notice-file';

  public validate(pkg: PackageJson): void {
    fileShouldBe(this.name, pkg, 'NOTICE', NOTICE);
  }
}

/**
 * Author must be AWS (as an Organization)
 */
export class AuthorAWS extends ValidationRule {
  public readonly name = 'package-info/author';

  public validate(pkg: PackageJson): void {
    expectJSON(this.name, pkg, 'author.name', 'Amazon Web Services');
    expectJSON(this.name, pkg, 'author.url', 'https://aws.amazon.com');
    expectJSON(this.name, pkg, 'author.organization', true);
  }
}

/**
 * There must be a README.md file.
 */
export class ReadmeFile extends ValidationRule {
  public readonly name = 'package-info/README.md';

  public validate(pkg: PackageJson): void {
    const readmeFile = path.join(pkg.packageRoot, 'README.md');

    const scopes = pkg.json['cdk-build'] && pkg.json['cdk-build'].cloudformation;
    if (!scopes) {
      return;
    }
    if (pkg.packageName === '@aws-cdk/core') {
      return;
    }
    const scope: string = typeof scopes === 'string' ? scopes : scopes[0];
    const serviceName = AWS_SERVICE_NAMES[scope];

    const headline = serviceName && `${serviceName} Construct Library`;

    if (!fs.existsSync(readmeFile)) {
      pkg.report({
        ruleName: this.name,
        message: 'There must be a README.md file at the root of the package',
        fix: () => fs.writeFileSync(
          readmeFile,
          [
            `## ${headline || pkg.json.description}`,
            'This module is part of the[AWS Cloud Development Kit](https://github.com/aws/aws-cdk) project.',
          ].join('\n'),
        ),
      });
    } else if (headline) {
      const requiredFirstLine = `## ${headline}`;
      const [firstLine, ...rest] = fs.readFileSync(readmeFile, { encoding: 'utf8' }).split('\n');
      if (firstLine !== requiredFirstLine) {
        pkg.report({
          ruleName: this.name,
          message: `The title of the README.md file must be "${headline}"`,
          fix: () => fs.writeFileSync(readmeFile, [requiredFirstLine, ...rest].join('\n')),
        });
      }
    }
  }
}

const MATURITY_TO_STABILITY: Record<string, string> = {
  'cfn-only': 'experimental',
  'experimental': 'experimental',
  'developer-preview': 'experimental',
  'stable': 'stable',
  'deprecated': 'deprecated',
};

/**
 * There must be a stability setting, and it must match the package maturity.
 *
 * Maturity setting is leading here (as there are more options than the
 * stability setting), but the stability setting must be present for `jsii`
 * to properly read and encode it into the assembly.
 */
export class StabilitySetting extends ValidationRule {
  public readonly name = 'package-info/stability';

  public validate(pkg: PackageJson): void {
    if (pkg.json.private) {
      // Does not apply to private packages!
      return;
    }

    const maturity = pkg.json.maturity as string | undefined;
    const stability = pkg.json.stability as string | undefined;

    const expectedStability = maturity ? MATURITY_TO_STABILITY[maturity] : undefined;
    if (!stability || (expectedStability && stability !== expectedStability)) {
      pkg.report({
        ruleName: this.name,
        message: `stability is '${stability}', but based on maturity is expected to be '${expectedStability}'`,
        fix: expectedStability ? (() => pkg.json.stability = expectedStability) : undefined,
      });
    }
  }
}

/**
 * Keywords must contain RFDK keywords.
 */
export class Keywords extends ValidationRule {
  public readonly name = 'package-info/keywords';

  public validate(pkg: PackageJson): void {
    if (!pkg.json.keywords) {
      pkg.report({
        ruleName: this.name,
        message: 'Must have keywords',
        fix: () => { pkg.json.keywords = []; },
      });
    }

    const keywords = pkg.json.keywords || [];
    const requiredKeywords = [
      'CDK',
      'AWS',
      'RFDK',
    ];
    for (const keyword of requiredKeywords) {
      const lowerKeyword = keyword.toLowerCase();
      if (keywords.indexOf(lowerKeyword) === -1) {
        pkg.report({
          ruleName: this.name,
          message: `Keywords must mention ${keyword}`,
          fix: () => { pkg.json.keywords.splice(0, 0, lowerKeyword); },
        });
      }
    }
  }
}

export class JSIIPythonTarget extends ValidationRule {
  public readonly name = 'jsii/python';

  public validate(pkg: PackageJson): void {
    if (!isJSII(pkg)) { return; }

    const moduleName = rfdkModuleName(pkg.json.name);

    expectJSON(this.name, pkg, 'jsii.targets.python.distName', moduleName.python.distName);
    expectJSON(this.name, pkg, 'jsii.targets.python.module', moduleName.python.module);
  }
}

export class RFDKPackage extends ValidationRule {
  public readonly name = 'package-info/scripts/package';

  public validate(pkg: PackageJson): void {
    // skip private packages
    if (pkg.json.private) { return; }

    if (!shouldUseCDKBuildTools(pkg)) { return; }

    const merkleMarker = '.LAST_PACKAGE';

    expectJSON(this.name, pkg, 'scripts.package', 'cdk-package');

    const outdir = 'dist';

    // if this is
    if (isJSII(pkg)) {
      expectJSON(this.name, pkg, 'jsii.outdir', outdir);
    }

    fileShouldContain(this.name, pkg, '.npmignore', outdir);
    fileShouldContain(this.name, pkg, '.gitignore', outdir);
    fileShouldContain(this.name, pkg, '.npmignore', merkleMarker);
    fileShouldContain(this.name, pkg, '.gitignore', merkleMarker);
  }
}

export class NoTsBuildInfo extends ValidationRule {
  public readonly name = 'npmignore/tsbuildinfo';

  public validate(pkg: PackageJson): void {
    // skip private packages
    if (pkg.json.private) { return; }

    // Stop 'tsconfig.tsbuildinfo' and regular '.tsbuildinfo' files from being
    // published to NPM.
    // We might at some point also want to strip tsconfig.json but for now,
    // the TypeScript DOCS BUILD needs to it to load the typescript source.
    fileShouldContain(this.name, pkg, '.npmignore', '*.tsbuildinfo');
  }
}

export class NoTsConfig extends ValidationRule {
  public readonly name = 'npmignore/tsconfig';

  public validate(pkg: PackageJson): void {
    // skip private packages
    if (pkg.json.private) { return; }

    fileShouldContain(this.name, pkg, '.npmignore', 'tsconfig.json');
  }
}

export class IncludeJsiiInNpmTarball extends ValidationRule {
  public readonly name = 'npmignore/jsii-included';

  public validate(pkg: PackageJson): void {
    // only jsii modules
    if (!isJSII(pkg)) { return; }

    // skip private packages
    if (pkg.json.private) { return; }

    fileShouldNotContain(this.name, pkg, '.npmignore', '.jsii');
    fileShouldContain(this.name, pkg, '.npmignore', '!.jsii'); // make sure .jsii is included
  }
}

/**
 * Verifies there is no dependency on "jsii" since it's defined at the repo
 * level.
 */
export class NoJsiiDep extends ValidationRule {
  public readonly name = 'dependencies/no-jsii';

  public validate(pkg: PackageJson): void {
    const predicate = (s: string) => s.startsWith('jsii');

    if (pkg.getDevDependency(predicate)) {
      pkg.report({
        ruleName: this.name,
        message: 'packages should not have a devDep on jsii since it is defined at the repo level',
        fix: () => pkg.removeDevDependency(predicate),
      });
    }
  }
}

/**
 * Verifies that the expected versions of node will be supported.
 */
export class NodeCompatibility extends ValidationRule {
  public readonly name = 'dependencies/node-version';

  public validate(pkg: PackageJson): void {
    const atTypesNode = pkg.getDevDependency('@types/node');
    if (atTypesNode && !atTypesNode.startsWith('^10.')) {
      pkg.report({
        ruleName: this.name,
        message: `packages must support node version 10 and up, but ${atTypesNode} is declared`,
        fix: () => pkg.addDevDependency('@types/node', '^10.17.5'),
      });
    }
  }
}

/**
 * Verifies that the ``@types/`` dependencies are correctly recorded in ``devDependencies`` and not ``dependencies``.
 */
export class NoAtTypesInDependencies extends ValidationRule {
  public readonly name = 'dependencies/at-types';

  public validate(pkg: PackageJson): void {
    const predicate = (s: string) => s.startsWith('@types/');
    for (const dependency of pkg.getDependencies(predicate)) {
      pkg.report({
        ruleName: this.name,
        message: `dependency on ${dependency.name}@${dependency.version} must be in devDependencies`,
        fix: () => {
          pkg.addDevDependency(dependency.name, dependency.version);
          pkg.removeDependency(predicate);
        },
      });
    }
  }
}

function isCdkModuleName(name: string) {
  return !!name.match(/^@aws-cdk\//);
}

/**
 * Computes the module name for various other purposes (java package, ...)
 */
function rfdkModuleName(name: string) {
  name = name.replace(/^aws-rfdk-/, '');
  name = name.replace(/^@aws-rfdk\//, '');

  return {
    python: {
      distName: 'aws-rfdk',
      module: 'aws_rfdk',
    },
  };
}

/**
 * The package must depend on cdk-build-tools
 */
export class MustDependOnBuildTools extends ValidationRule {
  public readonly name = 'dependencies/build-tools';

  public validate(pkg: PackageJson): void {
    if (!shouldUseCDKBuildTools(pkg)) { return; }

    expectDevDependency(this.name,
      pkg,
      'cdk-build-tools',
      `${require('../../cdk-build-tools/package.json').version}`); // eslint-disable-line @typescript-eslint/no-require-imports
  }
}

/**
 * Build script must be 'cdk-build'
 */
export class MustUseCDKBuild extends ValidationRule {
  public readonly name = 'package-info/scripts/build';

  public validate(pkg: PackageJson): void {
    if (!shouldUseCDKBuildTools(pkg)) { return; }

    expectJSON(this.name, pkg, 'scripts.build', 'cdk-build');

    // cdk-build will write a hash file that we have to ignore.
    const merkleMarker = '.LAST_BUILD';
    fileShouldContain(this.name, pkg, '.gitignore', merkleMarker);
    fileShouldContain(this.name, pkg, '.npmignore', merkleMarker);
  }
}

/**
 * Dependencies in both regular and peerDependencies must agree in semver
 *
 * In particular, verify that depVersion satisfies peerVersion. This prevents
 * us from instructing NPM to construct impossible closures, where we say:
 *
 *    peerDependency: A@1.0.0
 *    dependency: A@2.0.0
 *
 * There is no version of A that would satisfy this.
 *
 * The other way around is not necessary--the depVersion can be bumped without
 * bumping the peerVersion (if the API didn't change this may be perfectly
 * valid). This prevents us from restricting a user's potential combinations of
 * libraries unnecessarily.
 */
export class RegularDependenciesMustSatisfyPeerDependencies extends ValidationRule {
  public readonly name = 'dependencies/peer-dependencies-satisfied';

  public validate(pkg: PackageJson): void {
    for (const [depName, peerVersion] of Object.entries(pkg.peerDependencies)) {
      const depVersion = pkg.dependencies[depName];
      if (depVersion === undefined) { continue; }

      // Make sure that depVersion satisfies peerVersion.
      if (!semver.intersects(depVersion, peerVersion)) {
        pkg.report({
          ruleName: this.name,
          message: `dependency ${depName}: concrete version ${depVersion} does not match peer version '${peerVersion}'`,
          fix: () => pkg.addPeerDependency(depName, depVersion),
        });
      }
    }
  }
}

/**
 * Check that dependencies on @aws-cdk/ packages use point versions (not version ranges)
 * and that they are also defined in `peerDependencies`.
 */
export class MustDependonCdkByPointVersions extends ValidationRule {
  public readonly name = 'dependencies/cdk-point-dependencies';

  public validate(pkg: PackageJson): void {
    // yes, ugly, but we have a bunch of references to other files in the repo.
    // we use the root package.json to determine what should be the version
    // across the repo: in local builds, this should be 0.0.0 and in CI builds
    // this would be the actual version of the repo after it's been aligned
    // using scripts/align-version.sh
    const expectedVersion = require('../../../package.json').version; // eslint-disable-line @typescript-eslint/no-require-imports
    const ignore = [
      '@aws-cdk/cloudformation-diff',
      '@aws-cdk/cfnspec',
      '@aws-cdk/cx-api',
      '@aws-cdk/cloud-assembly-schema',
      '@aws-cdk/region-info',
    ];

    for (const [depName, depVersion] of Object.entries(pkg.dependencies)) {
      if (!isCdkModuleName(depName) || ignore.includes(depName)) {
        continue;
      }

      const peerDep = pkg.peerDependencies[depName];
      if (!peerDep) {
        pkg.report({
          ruleName: this.name,
          message: `dependency ${depName} must also appear in peerDependencies`,
          fix: () => pkg.addPeerDependency(depName, expectedVersion),
        });
      }

      if (peerDep !== expectedVersion) {
        pkg.report({
          ruleName: this.name,
          message: `peer dependency ${depName} should have the version ${expectedVersion}`,
          fix: () => pkg.addPeerDependency(depName, expectedVersion),
        });
      }

      if (depVersion !== expectedVersion) {
        pkg.report({
          ruleName: this.name,
          message: `dependency ${depName}: dependency version must be ${expectedVersion}`,
          fix: () => pkg.addDependency(depName, expectedVersion),
        });
      }
    }
  }
}

export class MustIgnoreSNK extends ValidationRule {
  public readonly name = 'ignore/strong-name-key';

  public validate(pkg: PackageJson): void {
    fileShouldContain(this.name, pkg, '.npmignore', '*.snk');
    fileShouldContain(this.name, pkg, '.gitignore', '*.snk');
  }
}

export class MustIgnoreJunitXml extends ValidationRule {
  public readonly name = 'ignore/junit';

  public validate(pkg: PackageJson): void {
    fileShouldContain(this.name, pkg, '.npmignore', 'junit.xml');
    fileShouldContain(this.name, pkg, '.gitignore', 'junit.xml');
  }
}

export class NpmIgnoreForJsiiModules extends ValidationRule {
  public readonly name = 'ignore/jsii';

  public validate(pkg: PackageJson): void {
    if (!isJSII(pkg)) { return; }

    fileShouldContain(this.name, pkg, '.npmignore',
      '*.ts',
      '!*.d.ts',
      '!*.js',
      'coverage',
      '.nyc_output',
      '*.tgz',
    );
  }
}

/**
 * Must use 'cdk-watch' command
 */
export class MustUseCDKWatch extends ValidationRule {
  public readonly name = 'package-info/scripts/watch';

  public validate(pkg: PackageJson): void {
    if (!shouldUseCDKBuildTools(pkg)) { return; }

    expectJSON(this.name, pkg, 'scripts.watch', 'cdk-watch');
  }
}

/**
 * Must use 'cdk-test' command
 */
export class MustUseCDKTest extends ValidationRule {
  public readonly name = 'package-info/scripts/test';

  public validate(pkg: PackageJson): void {
    if (!shouldUseCDKBuildTools(pkg)) { return; }
    if (!hasTestDirectory(pkg)) { return; }

    expectJSON(this.name, pkg, 'scripts.test', 'cdk-test');

    // 'cdk-test' will calculate coverage, so have the appropriate
    // files in .gitignore.
    fileShouldContain(this.name, pkg, '.gitignore', '.nyc_output');
    fileShouldContain(this.name, pkg, '.gitignore', 'coverage');
    fileShouldContain(this.name, pkg, '.gitignore', 'nyc.config.js');
  }
}

/**
 * Must declare minimum node version
 */
export class MustHaveNodeEnginesDeclaration extends ValidationRule {
  public readonly name = 'package-info/engines';

  public validate(pkg: PackageJson): void {
    expectJSON(this.name, pkg, 'engines.node', '>= 10.13.0 <13 || >=13.7.0');
  }
}

/**
 * Scripts that run integ tests must also have the individual 'integ' script to update them
 *
 * This commands comes from the dev-dependency cdk-integ-tools.
 */
export class MustHaveIntegCommand extends ValidationRule {
  public readonly name = 'package-info/scripts/integ';

  public validate(pkg: PackageJson): void {
    if (!hasIntegTests(pkg)) { return; }

    expectJSON(this.name, pkg, 'scripts.integ', 'cdk-integ');
    expectDevDependency(this.name,
      pkg,
      'cdk-integ-tools',
      `${require('../../cdk-integ-tools/package.json').version}`); // eslint-disable-line @typescript-eslint/no-require-imports
  }
}

/**
 * Checks API backwards compatibility against the latest released version.
 */
export class CompatScript extends ValidationRule {
  public readonly name = 'package-info/scripts/compat';

  public validate(pkg: PackageJson): void {
    if (!isJSII(pkg)) { return ; }

    expectJSON(this.name, pkg, 'scripts.compat', 'cdk-compat');
  }
}

export class PkgLintAsScript extends ValidationRule {
  public readonly name = 'package-info/scripts/pkglint';

  public validate(pkg: PackageJson): void {
    const script = 'pkglint -f';

    expectDevDependency(this.name, pkg, 'pkglint', `${require('../package.json').version}`); // eslint-disable-line @typescript-eslint/no-require-imports

    if (!pkg.npmScript('pkglint')) {
      pkg.report({
        ruleName: this.name,
        message: 'a script called "pkglint" must be included to allow fixing package linting issues',
        fix: () => pkg.changeNpmScript('pkglint', () => script),
      });
    }

    if (pkg.npmScript('pkglint') !== script) {
      pkg.report({
        ruleName: this.name,
        message: 'the pkglint script should be: ' + script,
        fix: () => pkg.changeNpmScript('pkglint', () => script),
      });
    }
  }
}

export class NoStarDeps extends ValidationRule {
  public readonly name = 'dependencies/no-star';

  public validate(pkg: PackageJson) {
    reportStarDeps(this.name, pkg.json.depedencies);
    reportStarDeps(this.name, pkg.json.devDependencies);

    function reportStarDeps(ruleName: string, deps?: any) {
      deps = deps || {};
      Object.keys(deps).forEach(d => {
        if (deps[d] === '*') {
          pkg.report({
            ruleName,
            message: `star dependency not allowed for ${d}`,
          });
        }
      });
    }
  }
}

interface VersionCount {
  version: string;
  count: number;
}

/**
 * All consumed versions of dependencies must be the same
 *
 * NOTE: this rule will only be useful when validating multiple package.jsons at the same time
 */
export class AllVersionsTheSame extends ValidationRule {
  public readonly name = 'dependencies/versions-consistent';

  private readonly ourPackages: {[pkg: string]: string} = {};
  private readonly usedDeps: {[pkg: string]: VersionCount[]} = {};

  public prepare(pkg: PackageJson): void {
    this.ourPackages[pkg.json.name] = pkg.json.version;
    this.recordDeps(pkg.json.dependencies);
    this.recordDeps(pkg.json.devDependencies);
  }

  public validate(pkg: PackageJson): void {
    this.validateDeps(pkg, 'dependencies');
    this.validateDeps(pkg, 'devDependencies');
  }

  private recordDeps(deps: {[pkg: string]: string} | undefined) {
    if (!deps) { return; }

    Object.keys(deps).forEach(dep => {
      this.recordDep(dep, deps[dep]);
    });
  }

  private validateDeps(pkg: PackageJson, section: string) {
    if (!pkg.json[section]) { return; }

    Object.keys(pkg.json[section]).forEach(dep => {
      this.validateDep(pkg, section, dep);
    });
  }

  private recordDep(dep: string, version: string) {
    if (version === '*') {
      // '*' does not give us info, so skip
      return;
    }

    if (!(dep in this.usedDeps)) {
      this.usedDeps[dep] = [];
    }

    const i = this.usedDeps[dep].findIndex(vc => vc.version === version);
    if (i === -1) {
      this.usedDeps[dep].push({ version, count: 1 });
    } else {
      this.usedDeps[dep][i].count += 1;
    }
  }

  private validateDep(pkg: PackageJson, depField: string, dep: string) {
    if (dep in this.ourPackages) {
      expectJSON(this.name, pkg, depField + '.' + dep, this.ourPackages[dep]);
      return;
    }

    // Otherwise, must match the majority version declaration. Might be empty if we only
    // have '*', in which case that's fine.
    if (!(dep in this.usedDeps)) { return; }

    const versions = this.usedDeps[dep];
    versions.sort((a, b) => b.count - a.count);
    expectJSON(this.name, pkg, depField + '.' + dep, versions[0].version);
  }
}

export class AwsLint extends ValidationRule {
  public readonly name = 'awslint';

  public validate(pkg: PackageJson) {
    if (!isJSII(pkg)) {
      return;
    }

    if (!isAWS(pkg)) {
      return;
    }

    expectJSON(this.name, pkg, 'scripts.awslint', 'cdk-awslint');
  }
}

export class Cfn2Ts extends ValidationRule {
  public readonly name = 'cfn2ts';

  public validate(pkg: PackageJson) {
    if (!isJSII(pkg) || !isAWS(pkg)) {
      return expectJSON(this.name, pkg, 'scripts.cfn2ts', undefined);
    }
  }
}

export class JestCoverageTarget extends ValidationRule {
  public readonly name = 'jest-coverage-target';

  public validate(pkg: PackageJson) {
    if (pkg.json.jest) {
      // We enforce the key exists, but the value is just a default
      const defaults: { [key: string]: number } = {
        branches: 80,
        statements: 80,
      };
      for (const key of Object.keys(defaults)) {
        const deepPath = ['coverageThreshold', 'global', key];
        const setting = deepGet(pkg.json.jest, deepPath);
        if (setting == null) {
          pkg.report({
            ruleName: this.name,
            message: `When jest is used, jest.coverageThreshold.global.${key} must be set`,
            fix: () => {
              deepSet(pkg.json.jest, deepPath, defaults[key]);
            },
          });
        }
      }
    }
  }
}

/**
 * Packages inside JSII packages (typically used for embedding Lambda handles)
 * must only have dev dependencies and their node_modules must have been
 * blacklisted for publishing
 *
 * We might loosen this at some point but we'll have to bundle all runtime dependencies
 * and we don't have good transitive license checks.
 */
export class PackageInJsiiPackageNoRuntimeDeps extends ValidationRule {
  public readonly name = 'lambda-packages-no-runtime-deps';

  public validate(pkg: PackageJson) {
    if (!isJSII(pkg)) { return; }

    for (const inner of findInnerPackages(pkg.packageRoot)) {
      const innerPkg = PackageJson.fromDirectory(inner);

      if (Object.keys(innerPkg.dependencies).length > 0) {
        pkg.report({
          ruleName: `${this.name}:1`,
          message: `NPM Package '${innerPkg.packageName}' inside jsii package can only have devDepencencies`,
        });
      }

      const nodeModulesRelPath = path.relative(pkg.packageRoot, innerPkg.packageRoot) + '/node_modules';
      fileShouldContain(`${this.name}:2`, pkg, '.npmignore', nodeModulesRelPath);
    }
  }
}

/**
 * Requires packages to have fast-fail build scripts, allowing to combine build, test and package in a single command.
 * This involves two targets: `build+test:pack` and `build+test` (to skip the pack).
 */
export class FastFailingBuildScripts extends ValidationRule {
  public readonly name = 'fast-failing-build-scripts';

  public validate(pkg: PackageJson) {
    const scripts = pkg.json.scripts || {};

    const hasTest = 'test' in scripts;
    const hasPack = 'package' in scripts;

    const cmdBuild = 'yarn run build';
    expectJSON(this.name, pkg, 'scripts.build+test', hasTest ? [cmdBuild, 'yarn test'].join(' && ') : cmdBuild);

    const cmdBuildTest = 'yarn run build+test';
    expectJSON(this.name, pkg, 'scripts.build+test+package', hasPack ? [cmdBuildTest, 'yarn run package'].join(' && ') : cmdBuildTest);
  }
}

export class YarnNohoistBundledDependencies extends ValidationRule {
  public readonly name = 'yarn/nohoist-bundled-dependencies';

  public validate(pkg: PackageJson) {
    const bundled: string[] = pkg.json.bundleDependencies || pkg.json.bundledDependencies || [];
    if (bundled.length === 0) { return; }

    const repoPackageJson = path.resolve(__dirname, '../../../package.json');

    const nohoist: string[] = require(repoPackageJson).workspaces.nohoist; // eslint-disable-line @typescript-eslint/no-require-imports

    const missing = new Array<string>();
    for (const dep of bundled) {
      for (const entry of [`${pkg.packageName}/${dep}`, `${pkg.packageName}/${dep}/**`]) {
        if (nohoist.indexOf(entry) >= 0) { continue; }
        missing.push(entry);
      }
    }

    if (missing.length > 0) {
      pkg.report({
        ruleName: this.name,
        message: `Repository-level 'workspaces.nohoist' directive is missing: ${missing.join(', ')}`,
        fix: () => {
          const packageJson = require(repoPackageJson); // eslint-disable-line @typescript-eslint/no-require-imports
          packageJson.workspaces.nohoist = [...packageJson.workspaces.nohoist, ...missing].sort();
          fs.writeFileSync(repoPackageJson, `${JSON.stringify(packageJson, null, 2)}\n`, { encoding: 'utf8' });
        },
      });
    }
  }
}

export class ConstructsDependency extends ValidationRule {
  public readonly name = 'constructs/dependency';

  public validate(pkg: PackageJson) {
    const REQUIRED_VERSION = '^3.2.0';

    if (pkg.devDependencies?.constructs && pkg.devDependencies?.constructs !== REQUIRED_VERSION) {
      pkg.report({
        ruleName: this.name,
        message: `"constructs" must have a version requirement ${REQUIRED_VERSION}`,
        fix: () => {
          pkg.addDevDependency('constructs', REQUIRED_VERSION);
        },
      });
    }

    if (pkg.dependencies.constructs && pkg.dependencies.constructs !== REQUIRED_VERSION) {
      pkg.report({
        ruleName: this.name,
        message: `"constructs" must have a version requirement ${REQUIRED_VERSION}`,
        fix: () => {
          pkg.addDependency('constructs', REQUIRED_VERSION);
        },
      });

      if (!pkg.peerDependencies.constructs || pkg.peerDependencies.constructs !== REQUIRED_VERSION) {
        pkg.report({
          ruleName: this.name,
          message: `"constructs" must have a version requirement ${REQUIRED_VERSION} in peerDependencies`,
          fix: () => {
            pkg.addPeerDependency('constructs', REQUIRED_VERSION);
          },
        });
      }
    }
  }
}

export class EslintSetup extends ValidationRule {
  public readonly name = 'package-info/eslint';

  public validate(pkg: PackageJson) {
    const eslintrcFilename = '.eslintrc.js';
    if (!fs.existsSync(eslintrcFilename)) {
      pkg.report({
        ruleName: this.name,
        message: 'There must be a .eslintrc.js file at the root of the package',
        fix: () => {
          const rootRelative = path.relative(pkg.packageRoot, repoRoot(pkg.packageRoot));
          fs.writeFileSync(
            eslintrcFilename,
            [
              `const baseConfig = require('${rootRelative}/tools/cdk-build-tools/config/eslintrc');`,
              "baseConfig.parserOptions.project = __dirname + '/tsconfig.json';",
              'module.exports = baseConfig;',
            ].join('\n') + '\n',
          );
        },
      });
    }
    fileShouldContain(this.name, pkg, '.gitignore', '!.eslintrc.js');
    fileShouldContain(this.name, pkg, '.npmignore', '.eslintrc.js');
  }
}

export class JestSetup extends ValidationRule {
  public readonly name = 'package-info/jest.config';

  public validate(pkg: PackageJson): void {
    const cdkBuild = pkg.json['cdk-build'] || {};

    // check whether the package.json contains the "jest" key,
    // which we no longer use
    if (pkg.json.jest) {
      pkg.report({
        ruleName: this.name,
        message: 'Using Jest is set through a flag in the "cdk-build" key in package.json, the "jest" key is ignored',
        fix: () => {
          delete pkg.json.jest;
          cdkBuild.jest = true;
          pkg.json['cdk-build'] = cdkBuild;
        },
      });
    }

    // this rule should only be enforced for packages that use Jest for testing
    if (!cdkBuild.jest) {
      return;
    }

    const jestConfigFilename = 'jest.config.js';
    if (!fs.existsSync(jestConfigFilename)) {
      pkg.report({
        ruleName: this.name,
        message: 'There must be a jest.config.js file at the root of the package',
        fix: () => {
          const rootRelative = path.relative(pkg.packageRoot, repoRoot(pkg.packageRoot));
          fs.writeFileSync(
            jestConfigFilename,
            [
              `const baseConfig = require('${rootRelative}/tools/cdk-build-tools/config/jest.config');`,
              'module.exports = baseConfig;',
            ].join('\n') + '\n',
          );
        },
      });
    }
    fileShouldContain(this.name, pkg, '.gitignore', '!jest.config.js');
    fileShouldContain(this.name, pkg, '.npmignore', 'jest.config.js');
  }
}

/**
 * Determine whether this is a JSII package
 *
 * A package is a JSII package if there is 'jsii' section in the package.json
 */
function isJSII(pkg: PackageJson): boolean {
  return pkg.json.jsii;
}

/**
 * Indicates that this is an "AWS" package (i.e. that it it has a cloudformation source)
 * @param pkg
 */
function isAWS(pkg: PackageJson): boolean {
  return pkg.json['cdk-build']?.cloudformation != null;
}

/**
 * Determine whether the package has tests
 *
 * A package has tests if the root/test directory exists
 */
function hasTestDirectory(pkg: PackageJson) {
  return fs.existsSync(path.join(pkg.packageRoot, 'test'));
}

/**
 * Whether this package has integ tests
 *
 * A package has integ tests if it mentions 'cdk-integ' in the "test" script.
 */
function hasIntegTests(pkg: PackageJson) {
  if (!hasTestDirectory(pkg)) { return false; }

  const files = fs.readdirSync(path.join(pkg.packageRoot, 'test'));
  return files.some(p => p.startsWith('integ.'));
}

/**
 * Return whether this package should use CDK build tools
 */
function shouldUseCDKBuildTools(pkg: PackageJson) {
  // The packages that DON'T use CDKBuildTools are the package itself
  // and the packages used by it.
  return pkg.packageName !== 'cdk-build-tools' && pkg.packageName !== 'merkle-build' && pkg.packageName !== 'awslint';
}

function repoRoot(dir: string) {
  let root = dir;
  for (let i = 0; i < 50 && !fs.existsSync(path.join(root, 'yarn.lock')); i++) {
    root = path.dirname(root);
  }
  return root;
}
