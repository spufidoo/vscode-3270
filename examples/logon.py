# logon — userid, Enter, then password, Enter, then Enter.
#
# settings.json:
#   "tn3270.macros": { "logon": { "script": "logon" } }
#
# Copy this file to the macros folder (3270 Terminal: Open Macros Folder).
# Do not put a password in this file.
#
# [wait] in a tape is wait_unlock() here. It returns when the keyboard
# unlocks, which can be before the next panel has finished painting.
#
# Copyright (c) 2026 Marcus Davage
# SPDX-License-Identifier: Apache-2.0

userid = ask("Userid")
if not userid:
    return

type(userid)
enter()
wait_unlock()

password = ask_password("Password")
if not password:
    return

type(password)
enter()
wait_unlock()
enter()
