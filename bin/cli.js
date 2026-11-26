#!/usr/bin/env node
'use strict';

const path = require('path');
const process = require('process');
const {program} = require('commander');
const rc = require('rc')('madge');
const version = require('../package.json').version;
const ora = require('ora').default;
const chalk = require('chalk').default;
const startTime = Date.now();

program
	.version(version)
	.usage('[options] <src...>')
	.argument('[src...]')
	.option('-b, --basedir <path>', 'base directory for resolving paths')
	.option('-s, --summary', 'show dependency count summary')
	.option('-c, --circular', 'show circular dependencies')
	.option('-d, --depends <name>', 'show module dependents')
	.option('-x, --exclude <regexp>', 'exclude modules using RegExp')
	.option('-j, --json', 'output as JSON')
	.option('-i, --image <file>', 'write graph to file as an image')
	.option('-l, --layout <name>', 'layout engine to use for graph (dot/neato/fdp/sfdp/twopi/circo)')
	.option('--orphans', 'show modules that no one is depending on')
	.option('--leaves', 'show modules that have no dependencies')
	.option('--dot', 'show graph using the DOT language')
	.option('--rankdir <direction>', 'set the direction of the graph layout')
	.option('--extensions <list>', 'comma separated string of valid file extensions')
	.option('--require-config <file>', 'path to RequireJS config')
	.option('--webpack-config <file>', 'path to webpack config')
	.option('--ts-config <file>', 'path to typescript config')
	.option('--include-npm', 'include shallow NPM modules', false)
	.option('--no-color', 'disable color in output and image')
	.option('--no-spinner', 'disable progress spinner')
	.option('--no-count', 'disable circular dependencies counting')
	.option('--stdin', 'read predefined tree from STDIN', false)
	.option('--warning', 'show warnings about skipped files', false)
	.option('--strict', 'fail on source parse errors or unresolved local imports', false)
	.option('--debug', 'turn on debug output', false)
	.parse(process.argv);

const options = program.opts();

if (!program.args.length && !options.stdin) {
	console.log(program.helpInformation());
	process.exit(1);
}

if (options.debug) {
	process.env.DEBUG = '*';
}

if (!options.color) {
	process.env.DEBUG_COLORS = false;
}

const log = require('../lib/log');
const output = require('../lib/output');
const madge = require('../lib/api');

let packageConfig = {};
try {
	packageConfig = require(path.join(process.cwd(), 'package.json')).madge;
} catch { }
const config = Object.assign(rc, packageConfig);

program.options.forEach((opt) => {
	const name = opt.name();

	if (options[name]) {
		config[name] = options[name];
	}
});

const spinner = ora({
	text: 'Finding files',
	color: 'white',
	interval: 100000,
	isEnabled: options.spinner === 'false' ? false : null
});

let exitCode = 0;

delete config._;
delete config.config;
delete config.configs;

if (rc.config) {
	log('using runtime config %s', rc.config);
}

if (options.basedir) {
	config.baseDir = options.basedir;
}

if (options.exclude) {
	config.excludeRegExp = [options.exclude];
}

if (options.extensions) {
	config.fileExtensions = options.extensions.split(',').map((s) => s.trim());
}

if (options.requireConfig) {
	config.requireConfig = options.requireConfig;
}

if (options.webpackConfig) {
	config.webpackConfig = options.webpackConfig;
}

if (options.tsConfig) {
	config.tsConfig = options.tsConfig;
}

if (options.includeNpm) {
	config.includeNpm = options.includeNpm;
}

if (!options.color) {
	config.backgroundColor = '#ffffff';
	config.nodeColor = '#000000';
	config.noDependencyColor = '#000000';
	config.cyclicNodeColor = '#000000';
	config.edgeColor = '#757575';
}

if (options.rankdir) {
	config.rankdir = options.rankdir;
}

function dependencyFilter() {
	let prevFile;

	return (dependencyFilePath, traversedFilePath, baseDir) => {
		if (prevFile !== traversedFilePath) {
			const relPath = path.relative(baseDir, traversedFilePath);
			const dir = path.dirname(relPath) + '/';
			const file = path.basename(relPath);

			spinner.text = chalk.grey(dir) + chalk.cyan(file);

			prevFile = traversedFilePath;
		}
	};
}

new Promise((resolve, reject) => {
	if (options.stdin) {
		let buffer = '';

		process.stdin
			.resume()
			.setEncoding('utf8')
			.on('data', (chunk) => {
				buffer += chunk;
			})
			.on('end', () => {
				try {
					resolve(JSON.parse(buffer));
				} catch (e) {
					reject(e);
				}
			});
	} else {
		resolve(program.args);
	}
})
	.then((src) => {
		if (!options.json && !options.dot) {
			spinner.start();
			config.dependencyFilter = dependencyFilter();
		}

		return madge(src, config);
	})
	.then((res) => {
		if (!options.json && !options.dot) {
			spinner.stop();
			output.getResultSummary(res, startTime);
		}

		const result = createOutputFromOptions(options, res);
		if (result !== undefined) {
			return result;
		}

		output.list(res.obj(), {
			json: options.json
		});

		return res;
	})
	.then((res) => {
		if (options.warning && !options.json) {
			output.warnings(res);
		}

		if (!options.json && !options.dot) {
			console.log('');
		}

		process.exit(exitCode);
	})
	.catch((err) => {
		spinner.stop();
		console.log('\n%s %s\n', chalk.red('✖'), err.stack);
		process.exit(1);
	});

function createOutputFromOptions(options, res) {
	if (options.summary) {
		output.summary(res.obj(), {
			json: options.json
		});

		return res;
	}

	if (options.depends) {
		output.modules(res.depends(options.depends), {
			json: options.json
		});

		return res;
	}

	if (options.orphans) {
		output.modules(res.orphans(), {
			json: options.json
		});

		return res;
	}

	if (options.leaves) {
		output.modules(res.leaves(), {
			json: options.json
		});

		return res;
	}

	if (options.image) {
		return res.image(options.image, options.circular).then((imagePath) => {
			spinner.succeed(`${chalk.bold('Image created at')} ${chalk.cyan.bold(imagePath)}`);
			return res;
		});
	}

	if (options.dot) {
		return res.dot(options.circular).then((output) => {
			process.stdout.write(output);
			return res;
		});
	}

	if (options.circular) {
		const circular = res.circular();

		output.circular(spinner, res, circular, {
			json: options.json,
			printCount: options.count
		});

		if (circular.length) {
			exitCode = 1;
		}

		return res;
	}
}
