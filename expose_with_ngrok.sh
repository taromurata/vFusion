#!/bin/bash

ngrok http "$(op item get vFusion --fields=port --reveal)" --url "$(op item get vFusion --fields=url --reveal)"
