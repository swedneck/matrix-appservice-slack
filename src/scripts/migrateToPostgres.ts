/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * This script will allow you to migrate your NeDB database
 * to a postgres one.
 */

import { Logging, MatrixUser, UserBridgeStore, RoomBridgeStore, EventBridgeStore } from "matrix-appservice-bridge";
import * as NeDB from "nedb";
import * as path from "path";
import { promisify } from "util";
import { NedbDatastore } from "../datastore/NedbDatastore";
import { PgDatastore } from "../datastore/postgres/PgDatastore";
import { BridgedRoom } from "../BridgedRoom";
import { SlackGhost } from "../SlackGhost";
import { Datastore, TeamEntry } from "../datastore/Models";
import { WebClient } from "@slack/web-api";
import { TeamInfoResponse } from "../SlackResponses";
import { SlackClientFactory } from "../SlackClientFactory";

Logging.configure({ console: "info" });
const log = Logging.get("script");

const POSTGRES_URL = process.argv[2];
const NEDB_DIRECTORY = process.argv[3] || "";
const USER_PREFIX = process.argv[4] || "slack_";

async function main() {
    if (!POSTGRES_URL) {
        log.error("You must specify the postgres url (ex: postgresql://user:pass@host/database");
        throw Error("");
    }
    const pgres = new PgDatastore(POSTGRES_URL);
    await pgres.ensureSchema();

    const config = {
        autoload: false,
    };

    const teamStore = new NeDB({ filename: path.join(NEDB_DIRECTORY, "teams.db"), ...config});
    const roomStore = new NeDB({ filename: path.join(NEDB_DIRECTORY, "room-store.db"), ...config});
    const userStore = new NeDB({ filename: path.join(NEDB_DIRECTORY, "user-store.db"), ...config});
    const eventStore = new NeDB({ filename: path.join(NEDB_DIRECTORY, "event-store.db"), ...config});

    try {
        await promisify(teamStore.loadDatabase).bind(teamStore)();
        await promisify(roomStore.loadDatabase).bind(roomStore)();
        await promisify(userStore.loadDatabase).bind(userStore)();
        await promisify(eventStore.loadDatabase).bind(eventStore)();
    } catch (ex) {
        log.error("Couldn't load datastores");
        log.error("Ensure you have given the correct path to the database.");
        throw ex;
    }

    const nedb = new NedbDatastore(
        new UserBridgeStore(userStore),
        new RoomBridgeStore(roomStore),
        new EventBridgeStore(eventStore),
        teamStore,
    );
    try {
        const startedAt = Date.now();
        await migrateFromNedb(nedb, pgres);
        log.info(`Completed migration in ${Math.round(Date.now() - startedAt)}ms`);
    } catch (ex) {
        log.error("An error occured while migrating databases:");
        log.error(ex);
        log.error("Your existing databases have not been modified, but you may need to drop the postgres table and start over");
    }
}

export async function migrateFromNedb(nedb: NedbDatastore, targetDs: Datastore) {
    const allRooms = await nedb.getAllRooms();
    const allEvents = await nedb.getAllEvents();
    // the format has changed quite a bit.
    // tslint:disable-next-line: no-any
    const allTeams = (await nedb.getAllTeams()) as any[];
    const allSlackUsers = await nedb.getAllUsers(false);
    const allMatrixUsers = await nedb.getAllUsers(true);

    const slackClientFactory = new SlackClientFactory(targetDs);

    log.info(`Migrating ${allRooms.length} rooms`);
    log.info(`Migrating ${allTeams.length} teams`);
    log.info(`Migrating ${allEvents.length} events`);
    log.info(`Migrating ${allSlackUsers.length} slack users`);
    log.info(`Migrating ${allMatrixUsers.length} matrix users`);

    const teamTokenMap: Map<string, string> = new Map(); // token -> teamId.
    let readyTeams: TeamEntry[];

    const preTeamMigrations = () => Promise.all(allRooms.map(async (room, i) => {
        // This is an old format remote
        // tslint:disable-next-line: no-any
        const remote = (room.remote as any);
        const at = remote.slack_bot_token || remote.access_token;
        if (!at) {
            return;
        }
        try {
            const teamId = await slackClientFactory.upsertTeamByToken(at);
            log.info("Got team from token:", teamId);
            teamTokenMap.set(at, teamId);
        } catch (ex) {
            log.warn("Failed to get team token for slack token:", ex);
        }
    }));

    const teamMigrations = () => Promise.all(allTeams.map(async (team, i) => {
        if (team.bot_token && !teamTokenMap.has(team.bot_token)) {
            let teamId: string;
            try {
                teamId = await slackClientFactory.upsertTeamByToken(team.bot_token);
            } catch (ex) {
                log.warn("Team token is not valid:", ex);
                return;
            }
            log.info("Got team from token:", teamId);
            teamTokenMap.set(team.bot_token, teamId);
        } else {
            log.info(`Skipped team (${i + 1}/${allTeams.length})`);
        }
        log.info(`Migrated team (${i + 1}/${allTeams.length})`);
    }));

    const roomMigrations = () => Promise.all(allRooms.map(async (room, i) => {
        // tslint:disable-next-line: no-any
        const token = (room.remote as any).slack_bot_token;
        if (!room.remote.slack_team_id && token) {
            room.remote.slack_team_id = teamTokenMap.get(token);
        }
        await targetDs.upsertRoom(BridgedRoom.fromEntry(null as any, room));
        log.info(`Migrated room ${room.id} (${i + 1}/${allRooms.length})`);
    }));

    const eventMigrations = () => Promise.all(allEvents.map(async (event, i) => {
        await targetDs.upsertEvent(event);
        log.info(`Migrated event ${event.eventId} ${event.slackTs} (${i + 1}/${allEvents.length})`);
    }));

    const slackUserMigrations = () => Promise.all(allSlackUsers.map(async (user, i) => {
        // tslint:disable-next-line: no-any
        let ghost = SlackGhost.fromEntry(null as any, user, null);
        if (!ghost.slackId || !ghost.teamId) {
            const localpart = ghost.userId.split(":")[0];
            // XXX: we are making an assumption here that the prefix ends with _
            const parts = localpart.substr(USER_PREFIX.length + 1).split("_"); // Remove any prefix.
            // If we encounter more parts than expected, the domain may be underscored
            while (parts.length > 2) {
                parts[0] = `${parts.shift()}_${parts[0]}`;
            }
            const existingTeam = readyTeams.find((t) => t.domain === parts[0]);
            if (!existingTeam) {
                log.warn("No existing team could be found for", ghost.userId);
                return;
            }
            user.slack_id = parts[1];
            user.team_id = existingTeam!.id;
            // tslint:disable-next-line: no-any
            ghost = SlackGhost.fromEntry(null as any, user, null);
        }
        await targetDs.upsertUser(ghost);
        log.info(`Migrated slack user ${user.id} (${i + 1}/${allSlackUsers.length})`);
    }));

    const matrixUserMigrations = () => Promise.all(allMatrixUsers.map(async (user, i) => {
        const mxUser = new MatrixUser(user.id, user);
        // tslint:disable-next-line: no-any
        await targetDs.storeMatrixUser(mxUser);
        log.info(`Migrated matrix user ${mxUser.getId()} (${i + 1}/${allMatrixUsers.length})`);
    }));
    log.info("Starting eventMigrations");
    await eventMigrations();
    log.info("Finished eventMigrations");
    log.info("Starting preTeamMigrations");
    await preTeamMigrations();
    log.info("Finished preTeamMigrations");
    log.info("Starting teamMigrations");
    await teamMigrations();
    log.info("Finished teamMigrations");
    readyTeams = await targetDs.getAllTeams();
    log.info("Starting roomMigrations");
    await roomMigrations();
    log.info("Finished roomMigrations");
    log.info("Starting slackUserMigrations");
    await slackUserMigrations();
    log.info("Finished slackUserMigrations");
    log.info("Starting matrixUserMigrations");
    await matrixUserMigrations();
    log.info("Finished matrixUserMigrations");
}

main().then(() => {
    log.info("finished");
}).catch((err) => {
    log.error("failed:", err);
});
