/* eslint-env node */
/* eslint-disable no-console */
"use strict";

const path = require("path");
const fs = require("fs-extra");
const gulp = require("gulp");
const stylus = require("gulp-stylus");
const nib = require("nib");
const vulcanize = require("gulp-vulcanize");
const crisper = require("gulp-crisper");
const rimraf = require("rimraf");
const insertLines = require("gulp-insert-lines");
const stylemod = require("gulp-style-modules");
const { exec } = require("child_process");
const builder = require("electron-builder");
const archiver = require("archiver");
const browserify = require("browserify");
const source = require("vinyl-source-stream");
const tsify = require("tsify");
const watchify = require("watchify");
const gulpWatch = require("gulp-watch");

const projectRoot = path.resolve(__dirname, "..");
const appDir = path.join(projectRoot, "app");
const { name, version, description, author, licence, homepage } =
    require(path.join(projectRoot, "package.json"));

function promisify(f) {
    return function() {
        return new Promise((resolve, reject) => {
            f(...arguments, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    };
}

const copy = promisify(fs.copy);
const rmdir = promisify(rimraf);
const writeFile = promisify(fs.writeFile);

function compileCss(watch = false) {
    let src = watch ? gulpWatch : gulp.src;
    src("./src/**/*.styl", {cwd: appDir})
        .pipe(stylus({use: [nib()]}))
        .pipe(stylemod())
        .pipe(gulp.dest("./src", {cwd: appDir}));
}

function compileCore(watch = false) {
    let b = browserify("app/src/core/main.ts", {
        standalone: "padlock",
        cache: {},
        packageCache: {}
    })
    .plugin(tsify);

    function bundle() {
        b.bundle()
            .pipe(source("padlock.js"))
            .pipe(gulp.dest("app/src/"));
    }

    if (watch) {
        b.plugin(watchify);
        b.on("update", bundle);
    }

    bundle();
}

function compileTests(watch = false) {
    let b = browserify("test/main.ts", {
        cache: {},
        packageCache: {}
    })
    .plugin(tsify);

    function bundle() {
        b.bundle()
            .pipe(source("tests.js"))
            .pipe(gulp.dest("test/"));
    }

    if (watch) {
        b.plugin(watchify);
        b.on("update", bundle);
    }

    bundle();
}

function compile(watch = false) {
    compileCss(watch);
    compileCore(watch);
    compileTests(watch);
}

function copyFiles(source, dest, files) {
    return Promise.all(files.map((f) => copy(path.resolve(source, f), path.resolve(dest, f))));
}

/**
 * Wraps a `require('child_process').exec(command)` call into a Promise
 * @param {String} command
 * @param {Boolean} logStderr Whether or not to write stderr of child process to stderr or main process
 * @param {Boolean} logStdout Whether or not to write stdout of child process to stdout or main process
 * @return {Promise}
 */
function pexec(command, logStderr = true, logStdout) {
    return new Promise(function(resolve, reject) {
        var cp = exec(command, function(err, stdout) {
            if (err) {
                reject(err);
            }
            resolve(stdout);
        });

        if (logStderr) {
            cp.stderr.on("error", console.error);
        }
        if (logStdout) {
            cp.stdout.on("data", console.log);
        }
    });
}

function pack(dest = "build") {
    return pexec(`pushd ${appDir} && bower install && popd`)
        .then(() => rmdir(dest))
        .then(() => compileCss())
        .then(() => {
            gulp.src("index.html", {cwd: appDir})
                .pipe(vulcanize({
                    inlineScripts: true,
                    inlineCss: true,
                    excludes: [
                        "overrides.css",
                        "cordova.js"
                    ]
                }))
                .pipe(insertLines({
                    "after": /<head>/i,
                    "lineAfter": "<meta http-equiv=\"Content-Security-Policy\"" +
                    " content=\"default-src 'self' gap:; style-src 'self'" +
                    " 'unsafe-inline'; connect-src https://*\">"
                }))
                .pipe(crisper())
                .pipe(gulp.dest(dest));
        })
        .then(() => copyFiles(appDir, dest, [
            "assets",
            "cordova.js",
            "overrides.css",
            "src/crypto.js",
            "bower_components/sjcl/sjcl.js"
        ]));
}

function buildChrome() {
    const dest = path.join(projectRoot, "dist/chrome");
    const buildDir = path.join(dest, "padlock");
    const chromeDir = path.join(projectRoot, "chrome");
    // The manifest file does not allow prerelease indicators in the version field
    const v = version.indexOf("-") === -1 ? version : version.substr(0, version.indexOf("-"));
    return pack(buildDir)
        .then(() => copyFiles(chromeDir, buildDir, [
            "background.js",
            "icons"
        ]))
        .then(() => {
            let manifest = require(path.join(chromeDir, "manifest.json"));
            Object.assign(manifest, { version: v, description, author });
            return writeFile(path.join(buildDir, "manifest.json"), JSON.stringify(manifest, null, "  "));
        })
        .then(() => new Promise((resolve, reject) => {
            let output = fs.createWriteStream(path.join(dest, `padlock-v${version}-chrome.zip`));
            let archive = archiver.create("zip");
            archive.directory(buildDir, "padlock");
            archive.on("error", reject);
            archive.on("finish", resolve);
            archive.pipe(output);
            archive.finalize();
        }));
}

function buildElectron(options) {
    const buildDir = "dist/electron";

    return pack("dist/electron")
        .then(() => copyFiles("electron", "dist/electron", [
            "main.js",
            "package.json"
        ]))
        .then(() => pexec(`pushd ${buildDir} && npm install && popd`))
        .then(() => builder.build({
            mac: options.mac && ["default"],
            win: options.win && ["nsis"],
            linux: options.linux && ["AppImage"],
            devMetadata: {
                build: {
                    appId: "com.maklesoft.padlock",
                    publish: {
                        provider: "github",
                        owner: "maklesoft",
                        repo: "padlock"
                    }
                },
                directories: {
                    buildResources: "electron",
                    app: "dist/electron",
                    output: "dist"
                }
            },
            appMetadata: {
                name, version, description, author, licence, homepage,
                productName: "Padlock",
                main: "main.js"
            },
            publish: options.release && "always"
        }));
}

module.exports = {
    compileCss: compileCss,
    compileCore: compileCore,
    compileTests: compileTests,
    compile: compile,
    pack: pack,
    buildChrome: buildChrome,
    buildElectron: buildElectron
};