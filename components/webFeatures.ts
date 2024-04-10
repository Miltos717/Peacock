/*
 *     The Peacock Project - a HITMAN server replacement.
 *     Copyright (C) 2021-2024 The Peacock Project Team
 *
 *     This program is free software: you can redistribute it and/or modify
 *     it under the terms of the GNU Affero General Public License as published by
 *     the Free Software Foundation, either version 3 of the License, or
 *     (at your option) any later version.
 *
 *     This program is distributed in the hope that it will be useful,
 *     but WITHOUT ANY WARRANTY; without even the implied warranty of
 *     MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *     GNU Affero General Public License for more details.
 *
 *     You should have received a copy of the GNU Affero General Public License
 *     along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { NextFunction, Request, Response, Router } from "express"
import { getConfig } from "./configSwizzleManager"
import { readdir, readFile } from "fs/promises"
import {
    ChallengeProgressionData,
    GameVersion,
    ProgressionData,
    UserProfile,
} from "./types/types"
import { join } from "path"
import {
    getRemoteService,
    isSniperLocation,
    levelForXp,
    uuidRegex,
    versions,
} from "./utils"
import { getUserData, loadUserData, writeUserData } from "./databaseHandler"
import { controller } from "./controller"
import { log, LogLevel } from "./loggingInterop"
import { userAuths } from "./officialServerAuth"
import { AxiosError } from "axios"
import { SNIPER_UNLOCK_TO_LOCATION } from "./menuData"

type OfficialProfileResponse = UserProfile & {
    Extensions: {
        progression: {
            Unlockables: {
                [unlockableId: string]: ProgressionData
            }
        }
    }
}

type SubPackageData = {
    [id: string]: ProgressionData
}

const webFeaturesRouter = Router()

if (PEACOCK_DEV) {
    webFeaturesRouter.use((_req, res, next) => {
        res.set("Access-Control-Allow-Origin", "*")
        res.set(
            "Access-Control-Allow-Methods",
            "GET,HEAD,PUT,PATCH,POST,DELETE",
        )
        res.set("Access-Control-Allow-Headers", "Content-Type")
        next()
    })
}

type CommonRequest<ExtraQuery = Record<never, never>> = Request<
    unknown,
    unknown,
    unknown,
    {
        user: string
        gv: Exclude<GameVersion, "scpc">
    } & ExtraQuery
>

function commonValidationMiddleware(
    req: CommonRequest,
    res: Response,
    next: NextFunction,
): void {
    if (!req.query.gv || !versions.includes(req.query.gv ?? null)) {
        res.json({
            success: false,
            error: "invalid game version",
        })
        return
    }

    if (!req.query.user || !uuidRegex.test(req.query.user)) {
        res.json({
            success: false,
            error: "The request must contain the uuid of a user.",
        })
        return
    }

    next()
}

function formErrorMessage(res: Response, message: string): void {
    res.json({
        success: false,
        error: message,
    })
}

webFeaturesRouter.get("/codenames", (_, res) => {
    res.json(getConfig("EscalationCodenames", false))
})

webFeaturesRouter.get("/local-users", async (req: CommonRequest, res) => {
    // Validate that gv is h1, h2, or h3
    function validateGv(gv: unknown): gv is "h1" | "h2" | "h3" {
        return versions.includes(gv as Exclude<GameVersion, "scpc">)
    }

    if (!validateGv(req.query.gv)) {
        res.json([])
        return
    }

    let dir

    if (req.query.gv === "h3") {
        dir = join("userdata", "users")
    } else {
        dir = join("userdata", req.query.gv, "users")
    }

    const files: string[] = (await readdir(dir)).filter(
        (name) => name !== "lop.json",
    )

    const result = []

    for (const file of files) {
        const read = JSON.parse(
            (await readFile(join(dir, file))).toString(),
        ) as UserProfile

        result.push({
            id: read.Id,
            name: read.Gamertag,
            platform: read.EpicId ? "Epic" : "Steam",
        })
    }

    res.json(result)
})

webFeaturesRouter.get(
    "/modify",
    commonValidationMiddleware,
    async (req: CommonRequest<{ level: string; id: string }>, res) => {
        if (!req.query.level) {
            formErrorMessage(
                res,
                "The request must contain the level to set the escalation to.",
            )
            return
        }

        if (
            isNaN(parseInt(req.query.level)) ||
            parseInt(req.query.level) <= 0
        ) {
            formErrorMessage(res, "The level must be a positive integer.")
            return
        }

        if (!req.query.id || !uuidRegex.test(req.query.id)) {
            formErrorMessage(
                res,
                "The request must contain the uuid of an escalation.",
            )
            return
        }

        try {
            await loadUserData(req.query.user, req.query.gv)
        } catch (e) {
            formErrorMessage(res, "Failed to load user data.")
            return
        }

        const mapping = controller.escalationMappings.get(req.query.id)

        if (!mapping) {
            formErrorMessage(res, "Unknown escalation.")
            return
        }

        if (Object.keys(mapping).length < parseInt(req.query.level, 10)) {
            formErrorMessage(
                res,
                "Cannot exceed the maximum level for this escalation!",
            )
            return
        }

        log(
            LogLevel.INFO,
            `Setting the level of escalation ${req.query.id} to ${req.query.level}`,
        )
        const read = getUserData(req.query.user, req.query.gv)

        read.Extensions.PeacockEscalations[req.query.id] = parseInt(
            req.query.level,
        )

        if (
            read.Extensions.PeacockCompletedEscalations.includes(req.query.id)
        ) {
            read.Extensions.PeacockCompletedEscalations =
                read.Extensions.PeacockCompletedEscalations.filter(
                    (val) => val !== req.query.id,
                )
        }

        writeUserData(req.query.user, req.query.gv)

        res.json({ success: true })
    },
)

webFeaturesRouter.get(
    "/user-progress",
    commonValidationMiddleware,
    async (req: CommonRequest, res) => {
        try {
            await loadUserData(req.query.user, req.query.gv)
        } catch (e) {
            formErrorMessage(res, "Failed to load user data.")
            return
        }

        const d = getUserData(req.query.user, req.query.gv)

        res.json(d.Extensions.PeacockEscalations)
    },
)

webFeaturesRouter.get(
    "/sync-progress",
    commonValidationMiddleware,
    async (req: CommonRequest, res) => {
        try {
            await loadUserData(req.query.user, req.query.gv)
        } catch (e) {
            formErrorMessage(res, "Failed to load user data.")
            return
        }

        const d = getUserData(req.query.user, req.query.gv)

        res.json({
            success: true,
            lastOfficialSync: d.Extensions.LastOfficialSync,
        })
    },
)

webFeaturesRouter.post(
    "/sync-progress",
    commonValidationMiddleware,
    async (req: CommonRequest, res) => {
        const remoteService = getRemoteService(req.query.gv)
        const auth = userAuths.get(req.query.user)

        if (!auth) {
            formErrorMessage(
                res,
                "Failed to get official authentication data. Please connect to Peacock first.",
            )
            return
        }

        const userdata = getUserData(req.query.user, req.query.gv)

        try {
            const challengeProgression = await auth._useService<
                ChallengeProgressionData[]
            >(
                `https://${remoteService}.hitman.io/authentication/api/userchannel/ChallengesService/GetProgression`,
                false,
                {
                    profileid: req.query.user,
                    challengeids: controller.challengeService.getChallengeIds(
                        req.query.gv,
                    ),
                },
            )

            userdata.Extensions.ChallengeProgression = Object.fromEntries(
                challengeProgression.data.map((data) => {
                    return [
                        data.ChallengeId,
                        {
                            Ticked: data.Completed,
                            Completed: data.Completed,
                            CurrentState:
                                (data.State["CurrentState"] as string) ??
                                "Start",
                            State: data.State,
                        },
                    ]
                }),
            )

            const exts = await auth._useService<OfficialProfileResponse>(
                `https://${remoteService}.hitman.io/authentication/api/userchannel/ProfileService/GetProfile`,
                false,
                {
                    id: req.query.user,
                    extensions: [
                        "achievements",
                        "friends",
                        "gameclient",
                        "gamepersistentdata",
                        "opportunityprogression",
                        "progression",
                    ],
                },
            )

            userdata.Extensions.progression.PlayerProfileXP = {
                ...userdata.Extensions.progression.PlayerProfileXP,
                Total: exts.data.Extensions.progression.PlayerProfileXP.Total,
                ProfileLevel: levelForXp(
                    exts.data.Extensions.progression.PlayerProfileXP.Total,
                ),
                Sublocations:
                    exts.data.Extensions.progression.PlayerProfileXP.Sublocations.filter(
                        (value) => {
                            return !value.Location.startsWith("LOCATION_SNUG_")
                        },
                    ),
            }

            userdata.Extensions.gamepersistentdata =
                exts.data.Extensions.gamepersistentdata

            userdata.Extensions.opportunityprogression = Object.fromEntries(
                Object.keys(exts.data.Extensions.opportunityprogression).map(
                    (value) => [value, true],
                ),
            )

            userdata.Extensions.achievements = exts.data.Extensions.achievements

            for (const [locId, data] of Object.entries(
                exts.data.Extensions.progression.Locations,
            )) {
                const location = (
                    locId.startsWith("location_parent")
                        ? locId
                        : locId.replace("location_", "location_parent_")
                ).toUpperCase()

                if (isSniperLocation(location)) continue

                userdata.Extensions.progression.Locations[location] = {
                    Xp: data.Xp as number,
                    Level: data.Level as number,
                    PreviouslySeenXp: data.PreviouslySeenXp as number,
                }
            }

            for (const [unlockId, data] of Object.entries(
                exts.data.Extensions.progression.Unlockables,
            )) {
                const unlockableId = unlockId.toUpperCase()

                if (!(unlockableId in SNIPER_UNLOCK_TO_LOCATION)) continue
                ;(
                    userdata.Extensions.progression.Locations[
                        SNIPER_UNLOCK_TO_LOCATION[unlockableId]
                    ] as SubPackageData
                )[unlockableId] = {
                    Xp: data.Xp,
                    Level: data.Level,
                    PreviouslySeenXp: data.PreviouslySeenXp,
                }
            }

            userdata.Extensions.LastOfficialSync = new Date().toISOString()

            writeUserData(req.query.user, req.query.gv)
        } catch (error) {
            if (error instanceof AxiosError) {
                formErrorMessage(
                    res,
                    `Failed to sync official data: got ${error.response?.status} ${error.response?.statusText}.`,
                )
                return
            } else {
                formErrorMessage(
                    res,
                    `Failed to sync official data: got ${JSON.stringify(error)}.`,
                )
                return
            }
        }

        res.json({
            success: true,
        })
    },
)

export { webFeaturesRouter }
