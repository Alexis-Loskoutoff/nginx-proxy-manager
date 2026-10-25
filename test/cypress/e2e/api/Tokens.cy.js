/// <reference types="cypress" />

describe('Tokens endpoints', () => {
	const user = {
		email:  'cypress@example.com',
		secret: 'changeme',
	};
	const disabledUser = {
		email:  'disabled@example.com',
		secret: 'changeme',
	};
	const unknownEmail = 'nobody@example.com';

	const login = (identity, secret) => {
		return cy.request({
			method:           'POST',
			url:              '/api/tokens',
			body:             {identity, secret},
			failOnStatusCode: false,
		});
	};

	const median = (values) => {
		const sorted = [...values].sort((a, b) => a - b);
		const middle = Math.floor(sorted.length / 2);
		return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	};

	before(() => {
		cy.resetUsers();
		cy.getToken().then((token) => {
			cy.task('backendApiPost', {
				token: token,
				path:  '/api/users',
				data:  {
					name:        'Disabled User',
					nickname:    'Disabled',
					email:       disabledUser.email,
					is_disabled: true,
					auth:        {
						type:   'password',
						secret: disabledUser.secret,
					},
				},
			});
		});
	});

	it('Should give the same answer for an unknown email, a disabled account and a wrong password', () => {
		// Only the error is compared: CI runs the backend in debug mode, which adds a stack trace that a real
		// client never gets.
		login(user.email, 'not-the-password').then((wrongPassword) => {
			expect(wrongPassword.status).to.equal(400);
			expect(wrongPassword.body.error.message_i18n).to.equal('error.invalid-auth');

			login(unknownEmail, user.secret).then((unknown) => {
				expect(unknown.status).to.equal(wrongPassword.status);
				expect(unknown.body.error).to.deep.equal(wrongPassword.body.error);
			});

			login(disabledUser.email, disabledUser.secret).then((disabled) => {
				expect(disabled.status).to.equal(wrongPassword.status);
				expect(disabled.body.error).to.deep.equal(wrongPassword.body.error);
			});
		});
	});

	it('Should take as long to reject an unknown email as a wrong password', () => {
		// Checking a password with bcrypt is nearly all of the time a login takes, around half a second,
		// so a login that skips it for an unknown email answers in a few milliseconds instead. The two
		// medians are compared with each other rather than with a fixed time, which depends on the machine,
		// and a factor of two leaves room for noise while still catching a gap of a hundred times or more.
		// Rounds alternate which one goes first, so anything slowing the server down hits both alike.
		const rounds = 5;
		const attempts = {
			unknown:       [unknownEmail, user.secret],
			wrongPassword: [user.email, 'not-the-password'],
		};
		const durations = {
			unknown:       [],
			wrongPassword: [],
		};

		// Warm up first: the first requests can be slower for reasons that have nothing to do with the login.
		login(...attempts.unknown);
		login(...attempts.wrongPassword);

		for (let round = 0; round < rounds; round++) {
			const order = round % 2 ? ['unknown', 'wrongPassword'] : ['wrongPassword', 'unknown'];
			order.forEach((name) => {
				login(...attempts[name]).then((response) => {
					expect(response.status).to.equal(400);
					durations[name].push(response.duration);
				});
			});
		}

		cy.wrap(durations).then(() => {
			const unknown = median(durations.unknown);
			const wrongPassword = median(durations.wrongPassword);
			cy.log(`Median response time: unknown email ${unknown} ms, wrong password ${wrongPassword} ms`);
			expect(unknown).to.be.within(wrongPassword / 2, wrongPassword * 2);
		});
	});
});
