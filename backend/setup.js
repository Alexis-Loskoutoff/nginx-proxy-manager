import { installPlugins } from "./lib/certbot.js";
import { configGet, isSqlite } from "./lib/config.js";
import utils from "./lib/utils.js";
import { setup as logger } from "./logger.js";
import authModel from "./models/auth.js";
import certificateModel from "./models/certificate.js";
import settingModel from "./models/setting.js";
import userModel from "./models/user.js";
import userPermissionModel from "./models/user_permission.js";
import fs from "node:fs/promises";

export const isSetup = async () => {
	const row = await userModel.query().select("id").where("is_deleted", 0).first();
	return row?.id > 0;
};

/**
 * Creates a default admin users if one doesn't already exist in the database
 *
 * @returns {Promise}
 */
const setupDefaultUser = async () => {
	const initialAdminEmail = process.env.INITIAL_ADMIN_EMAIL;
	const initialAdminPassword = process.env.INITIAL_ADMIN_PASSWORD;

	// This will only create a new user when there are no active users in the database
	// and the INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD environment variables are set.
	// Otherwise, users should be shown the setup wizard in the frontend.
	// I'm keeping this legacy behavior in case some people are automating deployments.

	if (!initialAdminEmail || !initialAdminPassword) {
		return Promise.resolve();
	}

	const userIsetup = await isSetup();
	if (!userIsetup) {
		// Create a new user and set password
		logger.info(`Creating a new user: ${initialAdminEmail} with password: ${initialAdminPassword}`);

		const data = {
			is_deleted: 0,
			email: initialAdminEmail,
			name: "Administrator",
			nickname: "Admin",
			avatar: "",
			roles: ["admin"],
		};

		const user = await userModel.query().insertAndFetch(data);

		await authModel.query().insert({
			user_id: user.id,
			type: "password",
			secret: initialAdminPassword,
			meta: {},
		});

		await userPermissionModel.query().insert({
			user_id: user.id,
			visibility: "all",
			proxy_hosts: "manage",
			redirection_hosts: "manage",
			dead_hosts: "manage",
			streams: "manage",
			access_lists: "manage",
			certificates: "manage",
		});
		logger.info("Initial admin setup completed");
	}
};

/**
 * Creates default settings if they don't already exist in the database
 *
 * @returns {Promise}
 */
const setupDefaultSettings = async () => {
	const row = await settingModel.query().select("id").where({ id: "default-site" }).first();

	if (!row?.id) {
		await settingModel.query().insert({
			id: "default-site",
			name: "Default Site",
			description: "What to show when Nginx is hit with an unknown Host",
			value: "congratulations",
			meta: {},
		});
		logger.info("Default settings added");
	}
};

/**
 * Installs all Certbot plugins which are required for an installed certificate
 *
 * @returns {Promise}
 */
const setupCertbotPlugins = async () => {
	const certificates = await certificateModel.query().where("is_deleted", 0).andWhere("provider", "letsencrypt");

	if (certificates?.length) {
		const plugins = [];

		certificates.map((certificate) => {
			if (certificate.meta && certificate.meta.dns_challenge === true) {
				if (plugins.indexOf(certificate.meta.dns_provider) === -1) {
					plugins.push(certificate.meta.dns_provider);
				}

				// Deliberately does NOT write the DNS credentials file here any more.
				//
				// It used to, so that a later `certbot renew` would find the path recorded in its
				// renewal config. The effect was that every backend restart rewrote a plaintext
				// DNS provider API token for every DNS-01 certificate, and left it there.
				//
				// internalCertificate now writes that file immediately before it runs certbot and
				// removes it again afterwards, so there is exactly one writer and the credential
				// is on disk only for the length of a certbot run. Recreating the files at boot
				// would put every one of them straight back.
			}
			return true;
		});

		await installPlugins(plugins);

		if (plugins.length) {
			logger.info(`Added Certbot plugins ${plugins.join(", ")}`);
		}
	}
};

/**
 * Makes the files that hold secrets readable by their owner only. The SQLite
 * database holds DNS provider credentials, access list passwords and imported
 * private keys, and custom_ssl holds those keys again. Both used to be created
 * world-readable, so this runs on every start to fix existing installs too.
 * SQLite gives its journal files the mode of the database file.
 *
 * @returns {Promise}
 */
const setupFilePermissions = async () => {
	const paths = [["/data/custom_ssl", 0o700]];
	if (isSqlite()) {
		paths.push([configGet("database").knex.connection.filename, 0o600]);
	}

	for (const [path, mode] of paths) {
		try {
			await fs.chmod(path, mode);
		} catch (err) {
			logger.warn(`Could not restrict the permissions of ${path}: ${err.message}`);
		}
	}
};

/**
 * Starts a timer to call run the logrotation binary every two days
 * @returns {Promise}
 */
const setupLogrotation = () => {
	const intervalTimeout = 1000 * 60 * 60 * 24 * 2; // 2 days

	const runLogrotate = async () => {
		try {
			await utils.exec("logrotate /etc/logrotate.d/nginx-proxy-manager");
			logger.info("Logrotate completed.");
		} catch (e) {
			logger.warn(e);
		}
	};

	logger.info("Logrotate Timer initialized");
	setInterval(runLogrotate, intervalTimeout);
	// And do this now as well
	return runLogrotate();
};

export default () =>
	setupFilePermissions()
		.then(setupDefaultUser)
		.then(setupDefaultSettings)
		.then(setupCertbotPlugins)
		.then(setupLogrotation);
